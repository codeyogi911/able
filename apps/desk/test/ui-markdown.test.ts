import { describe, expect, it } from 'vitest'

import { safeStreamingMarkdown } from '../src/ui/markdown'

describe('streaming markdown', () => {
  it('formats structured assistant answers', () => {
    const html = safeStreamingMarkdown('## Options\n\n- **G5** — ₹19,999\n- DF54 — ₹29,999')

    expect(html).toContain('<h2>Options</h2>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<strong>G5</strong>')
  })

  it('repairs incomplete emphasis while a response streams', () => {
    expect(safeStreamingMarkdown('The **Example G5')).toContain('<strong>Example G5</strong>')
  })

  it('renders incomplete links as text and rejects unsafe completed links', () => {
    expect(safeStreamingMarkdown('See [the grinder](https://shop.example')).toContain('See the grinder')
    expect(safeStreamingMarkdown('[bad](javascript:alert(1))')).not.toContain('href=')
  })

  it('allows safe storefront links', () => {
    expect(safeStreamingMarkdown('[View product](https://shop.example.test/products/g5)'))
      .toContain('href="https://shop.example.test/products/g5"')
  })
})
