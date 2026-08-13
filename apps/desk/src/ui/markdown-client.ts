import { safeStreamingMarkdown } from './markdown-core'

/** Mount a safe, stream-tolerant Markdown response into a browser surface. */
export function renderStreamingMarkdown(target: HTMLElement, markdown: string): void {
  target.classList.add('markdown-body')
  target.innerHTML = safeStreamingMarkdown(markdown)

  for (const link of target.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (link.origin !== window.location.origin) {
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
    }
  }
}
