export type PublicArticleSummary = {
  slug: string
  title: string
  excerpt: string
  section: string
}

export type PublicArticle = PublicArticleSummary & {
  bodyMarkdown: string
  updatedAt: string
}

export type GroundedArticle = PublicArticleSummary & {
  /** Bounded plain-text article content, safe to place in a model prompt. */
  content: string
}

export type PublicKnowledgeReader = {
  home(): Promise<{
    sections: Array<{ id: string; slug: string; name: string; description: string }>
    articles: PublicArticleSummary[]
  }>
  search(query: string): Promise<PublicArticleSummary[]>
  ground(query: string, limit?: number, contentChars?: number): Promise<GroundedArticle[]>
  article(slug: string): Promise<PublicArticle | null>
}

export type ActiveCategory = { id: string; name: string; description: string }

type ArticleRow = {
  slug: string
  title: string
  excerpt: string
  section: string
  body_markdown?: string
  updated_at?: string
}

async function all<T>(db: D1Database, sql: string, ...bindings: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...bindings).all<T>()).results
}

function summary(row: ArticleRow): PublicArticleSummary {
  return { slug: row.slug, title: row.title, excerpt: row.excerpt, section: row.section }
}

// Words that match nearly every article and would drown out the meaningful
// terms of a natural-language question such as "How often should I clean?".
const STOP_WORDS = new Set([
  'a', 'about', 'an', 'and', 'are', 'be', 'can', 'could', 'do', 'does', 'for', 'get', 'has',
  'have', 'how', 'if', 'in', 'is', 'it', 'me', 'my', 'need', 'not', 'of', 'on', 'or', 'our',
  'should', 'that', 'the', 'this', 'to', 'was', 'we', 'what', 'when', 'where', 'why', 'will',
  'with', 'would', 'you', 'your',
])

function searchTerms(queryInput: string): string[] {
  const tokens = [...new Set(
    queryInput
      .replaceAll('\u0000', ' ')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 2),
  )]
  const meaningful = tokens.filter((token) => !STOP_WORDS.has(token))
  return (meaningful.length > 0 ? meaningful : tokens).slice(0, 8)
}

function occurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1 && count < 5) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

type ScoredRow = ArticleRow & { body_markdown: string; updated_at: string }

function articleRank(row: ScoredRow, terms: string[]): { matched: number; score: number } {
  const title = row.title.toLowerCase()
  const excerpt = row.excerpt.toLowerCase()
  const body = row.body_markdown.toLowerCase()
  let matched = 0
  let score = 0
  for (const term of terms) {
    const bodyCount = occurrences(body, term)
    const inTitle = title.includes(term)
    const inExcerpt = excerpt.includes(term)
    if (inTitle || inExcerpt || bodyCount > 0) matched += 1
    if (inTitle) score += 30
    if (inExcerpt) score += 12
    score += bodyCount * 2
  }
  return { matched, score }
}

/** Markdown structure stripped down to prompt-safe plain text. */
function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>|]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*\n\s*/g, '\n\n')
    .trim()
}

async function scoredSearch(db: D1Database, queryInput: string): Promise<ScoredRow[]> {
  const query = queryInput.replaceAll('\u0000', '').trim().slice(0, 300)
  if (query.length < 2) return []
  const terms = searchTerms(query)
  if (terms.length === 0) return []
  const clause = terms
    .map(() => `(instr(lower(coalesce(article.title, '')), ?) > 0
      OR instr(lower(coalesce(article.excerpt, '')), ?) > 0
      OR instr(lower(coalesce(article.body_markdown, '')), ?) > 0)`)
    .join(' OR ')
  const rows = await all<ScoredRow>(
    db,
    `SELECT article.slug, article.title, article.excerpt, section.name AS section,
            article.body_markdown, article.updated_at
     FROM kb_articles article
     JOIN kb_sections section ON section.id = article.section_id
     WHERE article.published = 1 AND (${clause})
     LIMIT 60`,
    ...terms.flatMap((term) => [term, term, term]),
  )
  return rows
    .map((row) => ({ row, rank: articleRank(row, terms) }))
    .sort((first, second) =>
      second.rank.matched - first.rank.matched
      || second.rank.score - first.rank.score
      || second.row.updated_at.localeCompare(first.row.updated_at)
      || first.row.title.localeCompare(second.row.title))
    .map((entry) => entry.row)
}

export function createPublicKnowledge(db: D1Database): PublicKnowledgeReader {
  return {
    async home() {
      const [sections, articles] = await Promise.all([
        all<{ id: string; slug: string; name: string; description: string }>(
          db,
          'SELECT id, slug, name, description FROM kb_sections ORDER BY sort_order ASC, name ASC',
        ),
        all<ArticleRow>(
          db,
          `SELECT article.slug, article.title, article.excerpt, section.name AS section
           FROM kb_articles article
           JOIN kb_sections section ON section.id = article.section_id
           WHERE article.published = 1
           ORDER BY section.sort_order ASC, article.updated_at DESC, article.title ASC
           LIMIT 100`,
        ),
      ])
      return { sections, articles: articles.map(summary) }
    },

    async search(queryInput: string) {
      const rows = await scoredSearch(db, queryInput)
      return rows.slice(0, 30).map(summary)
    },

    async ground(queryInput: string, limit = 3, contentChars = 1_500) {
      const rows = await scoredSearch(db, queryInput)
      return rows.slice(0, Math.max(1, Math.min(limit, 8))).map((row) => ({
        ...summary(row),
        content: plainText(row.body_markdown).slice(0, Math.max(200, Math.min(contentChars, 4_000))),
      }))
    },

    async article(slugInput: string) {
      const slug = slugInput.replaceAll('\u0000', '').trim().toLowerCase().slice(0, 160)
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null
      const row = await db
        .prepare(
          `SELECT article.slug, article.title, article.excerpt, section.name AS section,
                  article.body_markdown, article.updated_at
           FROM kb_articles article
           JOIN kb_sections section ON section.id = article.section_id
           WHERE article.slug = ? AND article.published = 1`,
        )
        .bind(slug)
        .first<ArticleRow>()
      if (!row?.body_markdown || !row.updated_at) return null
      return { ...summary(row), bodyMarkdown: row.body_markdown, updatedAt: row.updated_at }
    },
  }
}

export async function listActiveCategories(db: D1Database): Promise<ActiveCategory[]> {
  return all<ActiveCategory>(
    db,
    `SELECT id, name, description FROM categories
     WHERE active = 1
     ORDER BY sort_order ASC, name ASC`,
  )
}
