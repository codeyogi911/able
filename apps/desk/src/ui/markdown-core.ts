import { marked } from 'marked'
import remend from 'remend'
import { FilterXSS } from 'xss'

const sanitizer = new FilterXSS({
  whiteList: {
    a: ['href', 'title'],
    p: [],
    br: [],
    hr: [],
    blockquote: [],
    h1: [],
    h2: [],
    h3: [],
    h4: [],
    h5: [],
    h6: [],
    ul: [],
    ol: ['start'],
    li: [],
    strong: [],
    em: [],
    b: [],
    i: [],
    del: [],
    s: [],
    code: ['class'],
    pre: [],
    table: [],
    thead: [],
    tbody: [],
    tr: [],
    th: ['align'],
    td: ['align'],
  },
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script', 'style', 'iframe', 'object'],
  onTagAttr(tag, name, value) {
    if (tag === 'a' && name === 'href') {
      const normalized = value.trim().toLowerCase()
      if (!normalized.startsWith('/') && !normalized.startsWith('#') && !normalized.startsWith('https://') && !normalized.startsWith('mailto:')) {
        return ''
      }
    }
    return undefined
  },
})

export function safeMarkdown(markdown: string): string {
  const rendered = marked.parse(markdown, { async: false }) as string
  return sanitizer.process(rendered)
}

/**
 * Render an in-progress model response without leaking partial Markdown
 * delimiters into the UI. Remend is the framework-independent termination
 * layer used by Streamdown; marked and xss own parsing and sanitisation.
 */
export function safeStreamingMarkdown(markdown: string): string {
  return safeMarkdown(remend(markdown, {
    inlineKatex: false,
    linkMode: 'text-only',
  }))
}
