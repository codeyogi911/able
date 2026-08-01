import { marked } from 'marked'
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

export function Markdown({ body }: { body: string }) {
  return <div class="prose" dangerouslySetInnerHTML={{ __html: safeMarkdown(body) }} />
}
