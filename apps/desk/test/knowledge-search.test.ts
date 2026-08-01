import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { createHelpdesk } from '../src/helpdesk'
import type { Actor, KnowledgeSearchResult } from '../src/domain/types'

const admin: Actor = {
  id: 'knowledge-admin',
  email: 'knowledge-admin@example.test',
  name: 'Knowledge Admin',
  role: 'admin',
}

const agent: Actor = {
  id: 'knowledge-agent',
  email: 'knowledge-agent@example.test',
  name: 'Knowledge Agent',
  role: 'agent',
}

function desk() {
  return createHelpdesk({
    db: env.DB,
    attachments: env.ATTACHMENTS,
    baseUrl: 'https://support.example.test',
    capabilitySecret: `test-${'0'.repeat(40)}`,
  })
}

describe('Helpdesk knowledge work', () => {
  it('searches published articles for agents and includes drafts with revisions for admins', async () => {
    await env.DB.prepare(
      `INSERT INTO kb_sections (id, slug, name) VALUES ('guides', 'guides', 'Guides')`,
    ).run()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO kb_articles
           (id, section_id, slug, title, body_markdown, excerpt, published, revision)
         VALUES ('article-public', 'guides', 'safe-startup', 'Safe startup',
                 'Follow this startup sequence.', 'Startup sequence.', 1, 'rev-public')`,
      ),
      env.DB.prepare(
        `INSERT INTO kb_articles
           (id, section_id, slug, title, body_markdown, excerpt, published, revision)
         VALUES ('article-draft', 'guides', 'startup-draft', 'Startup draft',
                 'Unreviewed startup notes.', 'Unreviewed notes.', 0, 'rev-draft')`,
      ),
    ])

    const agentResult = await desk().work(agent, { kind: 'knowledge', query: 'startup' })
    expect(agentResult).toMatchObject({
      kind: 'search',
      scope: 'knowledge',
      articles: [{ slug: 'safe-startup', published: true, revision: 'rev-public' }],
    })

    const adminResult = await desk().work(admin, { kind: 'knowledge', query: 'startup' })
    expect(adminResult).toMatchObject({ kind: 'search', scope: 'knowledge' })
    const knowledgeResult = adminResult as KnowledgeSearchResult
    expect(knowledgeResult.articles.map((article) => article.slug)).toEqual(['safe-startup', 'startup-draft'])
    expect(knowledgeResult.articles.find((article) => !article.published)?.revision).toBe('rev-draft')
  })
})
