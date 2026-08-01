import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { createPublicKnowledge } from '../src/helpdesk'

const knowledge = () => createPublicKnowledge(env.DB)

async function seed(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO kb_sections (id, slug, name) VALUES ('care', 'care', 'Care and cleaning')`,
  ).run()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO kb_articles (id, section_id, slug, title, body_markdown, excerpt, published, revision, updated_at)
       VALUES ('a-clean', 'care', 'cleaning-your-machine', 'Cleaning your label printer',
               '## When to clean\n\nClean the machine every **60 days** with a [citric acid solution](https://example.test/citric).\n\nRinse twice with fresh water afterwards.',
               'How and when to clean.', 1, 'rev-1', '2026-07-02T10:00:00.000Z')`,
    ),
    env.DB.prepare(
      `INSERT INTO kb_articles (id, section_id, slug, title, body_markdown, excerpt, published, revision, updated_at)
       VALUES ('a-vents', 'care', 'cleaning-router-vents', 'Cleaning printer rollers',
               'Remove the hopper, then brush the vents weekly. The machine keeps grinding evenly when vents stay clean.',
               'Weekly roller cleaning.', 1, 'rev-1', '2026-07-03T10:00:00.000Z')`,
    ),
    env.DB.prepare(
      `INSERT INTO kb_articles (id, section_id, slug, title, body_markdown, excerpt, published, revision, updated_at)
       VALUES ('a-shipping', 'care', 'shipping-timelines', 'Shipping timelines',
               'Orders ship within 2 business days. Machine deliveries include tracking.',
               'When orders ship.', 1, 'rev-1', '2026-07-04T10:00:00.000Z')`,
    ),
    env.DB.prepare(
      `INSERT INTO kb_articles (id, section_id, slug, title, body_markdown, excerpt, published, revision, updated_at)
       VALUES ('a-draft', 'care', 'clean-draft', 'Clean draft rewrite',
               'Clean clean clean. Unreviewed.', 'Draft.', 0, 'rev-1', '2026-07-05T10:00:00.000Z')`,
    ),
  ])
}

describe('public knowledge search', () => {
  it('ranks the on-topic article first for natural-language and keyword queries', async () => {
    await seed()
    const question = await knowledge().search('How often should I clean my machine?')
    expect(question[0]?.slug).toBe('cleaning-your-machine')
    expect(question.every((article) => article.slug !== 'clean-draft')).toBe(true)

    const keywords = await knowledge().search('printer rollers')
    expect(keywords[0]?.slug).toBe('cleaning-router-vents')
  })

  it('handles short and stop-word-only queries without failing', async () => {
    await seed()
    expect(await knowledge().search('x')).toEqual([])
    expect(await knowledge().search('   ')).toEqual([])
    expect(Array.isArray(await knowledge().search('how do i'))).toBe(true)
  })
})

describe('public knowledge grounding', () => {
  it('returns bounded plain text without markdown structure, with the facts intact', async () => {
    await seed()
    const grounded = await knowledge().ground('clean machine', 2)
    expect(grounded[0]?.slug).toBe('cleaning-your-machine')
    const content = grounded[0]?.content ?? ''
    expect(content).toContain('every 60 days')
    expect(content).toContain('citric acid solution')
    expect(content).not.toContain('**')
    expect(content).not.toContain('](')
    expect(content).not.toContain('##')
    expect(grounded.length).toBeLessThanOrEqual(2)

    const bounded = await knowledge().ground('machine', 3, 250)
    for (const article of bounded) expect(article.content.length).toBeLessThanOrEqual(250)
  })

  it('never grounds on unpublished drafts', async () => {
    await seed()
    const grounded = await knowledge().ground('clean unreviewed', 5)
    expect(grounded.length).toBeGreaterThan(0)
    expect(grounded.every((article) => article.slug !== 'clean-draft')).toBe(true)
  })
})
