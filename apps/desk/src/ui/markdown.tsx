import { safeMarkdown } from './markdown-core'

export { safeMarkdown, safeStreamingMarkdown } from './markdown-core'

export function Markdown({ body }: { body: string }) {
  return <div class="prose" dangerouslySetInnerHTML={{ __html: safeMarkdown(body) }} />
}
