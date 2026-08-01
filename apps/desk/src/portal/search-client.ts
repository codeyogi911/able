/**
 * Progressive enhancement for the help-centre search. Without JavaScript the
 * form still submits to /kb. With it, the input becomes a combobox with
 * instant results from /kb/search.json. Assistant conversations live at the
 * public root; this remains an ordinary knowledge-base search.
 */

type SearchResult = { slug: string; title: string; excerpt: string; section: string; url: string }

const RESULT_LIMIT = 6
const DEBOUNCE_MS = 160
const MIN_QUERY = 2

function isSafeUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.startsWith('/') && !value.startsWith('//')) return true
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function asResult(value: unknown): SearchResult | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (
    typeof record.slug !== 'string'
    || typeof record.title !== 'string'
    || typeof record.excerpt !== 'string'
    || typeof record.section !== 'string'
    || !isSafeUrl(record.url)
  ) return null
  return { slug: record.slug, title: record.title, excerpt: record.excerpt, section: record.section, url: record.url }
}

function highlight(target: HTMLElement, text: string, query: string): void {
  const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 2))]
  const lower = text.toLowerCase()
  const marks: Array<{ start: number; end: number }> = []
  for (const term of terms) {
    const start = lower.indexOf(term)
    if (start !== -1) marks.push({ start, end: start + term.length })
  }
  marks.sort((first, second) => first.start - second.start)
  const merged: Array<{ start: number; end: number }> = []
  for (const mark of marks) {
    const last = merged[merged.length - 1]
    if (last && mark.start <= last.end) last.end = Math.max(last.end, mark.end)
    else merged.push({ ...mark })
  }
  target.replaceChildren()
  let cursor = 0
  for (const mark of merged) {
    if (mark.start > cursor) target.append(document.createTextNode(text.slice(cursor, mark.start)))
    const emphasis = document.createElement('mark')
    emphasis.textContent = text.slice(mark.start, mark.end)
    target.append(emphasis)
    cursor = mark.end
  }
  if (cursor < text.length) target.append(document.createTextNode(text.slice(cursor)))
}

function enhance(form: HTMLFormElement): void {
  const foundInput = form.querySelector<HTMLInputElement>('input[type="search"]')
  const control = form.querySelector<HTMLElement>('.search-control')
  if (!foundInput || !control) return
  const input: HTMLInputElement = foundInput
  const listboxId = `${input.id || 'kb-search'}-listbox`

  const kbdHint = form.querySelector<HTMLElement>('.search-kbd')
  if (kbdHint && window.matchMedia('(pointer: fine)').matches) {
    kbdHint.textContent = /mac/i.test(navigator.platform) ? '⌘K' : 'Ctrl K'
    kbdHint.hidden = false
  }

  const panel = document.createElement('div')
  panel.className = 'search-panel'
  panel.hidden = true
  form.append(panel)

  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-expanded', 'false')
  input.setAttribute('aria-controls', listboxId)
  input.setAttribute('aria-autocomplete', 'list')

  let results: SearchResult[] = []
  let activeIndex = -1
  let debounceTimer = 0
  let searchAbort: AbortController | null = null
  const cache = new Map<string, SearchResult[]>()

  function options(): HTMLElement[] {
    return [...panel.querySelectorAll<HTMLElement>('[role="option"]')]
  }

  function close(): void {
    panel.hidden = true
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
    activeIndex = -1
  }

  function open(): void {
    panel.hidden = false
    input.setAttribute('aria-expanded', 'true')
  }

  function setActive(index: number): void {
    const items = options()
    activeIndex = items.length === 0 ? -1 : Math.max(0, Math.min(index, items.length - 1))
    items.forEach((item, itemIndex) => item.classList.toggle('is-active', itemIndex === activeIndex))
    const active = items[activeIndex]
    if (active) {
      input.setAttribute('aria-activedescendant', active.id)
      active.scrollIntoView({ block: 'nearest' })
    } else {
      input.removeAttribute('aria-activedescendant')
    }
  }

  function renderResults(): void {
    const query = input.value.trim()
    panel.replaceChildren()
    const list = document.createElement('div')
    list.id = listboxId
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', 'Search results')
    let optionIndex = 0

    for (const result of results.slice(0, RESULT_LIMIT)) {
      const row = document.createElement('a')
      row.className = 'search-option search-option--article'
      row.setAttribute('role', 'option')
      row.id = `${listboxId}-opt-${optionIndex++}`
      row.href = result.url
      const section = document.createElement('span')
      section.className = 'option-section'
      section.textContent = result.section
      const title = document.createElement('span')
      title.className = 'option-title'
      highlight(title, result.title, query)
      const excerpt = document.createElement('span')
      excerpt.className = 'option-excerpt'
      excerpt.textContent = result.excerpt
      row.append(section, title, excerpt)
      list.append(row)
    }

    if (results.length === 0 && query.length >= MIN_QUERY) {
      const empty = document.createElement('p')
      empty.className = 'search-empty'
      empty.textContent = 'No matching articles. Try fewer, more concrete words.'
      list.append(empty)
    }

    if (results.length > 0) {
      const all = document.createElement('a')
      all.className = 'search-option search-option--all'
      all.setAttribute('role', 'option')
      all.id = `${listboxId}-opt-${optionIndex++}`
      all.href = `/kb?q=${encodeURIComponent(query)}`
      all.textContent = `See all results for “${query}”`
      list.append(all)
    }

    panel.append(list)
    setActive(-1)
    open()
  }

  function runSearch(): void {
    const query = input.value.trim()
    if (query.length < MIN_QUERY) {
      results = []
      close()
      return
    }
    const cached = cache.get(query)
    if (cached) {
      results = cached
      renderResults()
      return
    }
    searchAbort?.abort()
    const abort = new AbortController()
    searchAbort = abort
    void fetch(`/kb/search.json?q=${encodeURIComponent(query)}`, { signal: abort.signal, credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) return
        const data = await response.json() as { results?: unknown }
        if (abort.signal.aborted || input.value.trim() !== query) return
        results = Array.isArray(data.results) ? data.results.flatMap((entry) => asResult(entry) ?? []) : []
        if (cache.size > 30) cache.clear()
        cache.set(query, results)
        renderResults()
      })
      .catch(() => {
        // Network failures degrade to the plain form submit.
      })
  }

  input.addEventListener('input', () => {
    window.clearTimeout(debounceTimer)
    debounceTimer = window.setTimeout(runSearch, DEBOUNCE_MS)
  })

  input.addEventListener('focus', () => {
    if (input.value.trim().length >= MIN_QUERY && panel.hidden) runSearch()
  })

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!panel.hidden) {
        event.preventDefault()
        close()
      }
      return
    }
    if (panel.hidden) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(activeIndex + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(activeIndex - 1)
    } else if (event.key === 'Enter') {
      const active = options()[activeIndex]
      if (active) {
        event.preventDefault()
        if (active instanceof HTMLAnchorElement) window.location.assign(active.href)
        else active.click()
      }
    }
  })

  form.addEventListener('submit', () => {
    // Keep the form's Search button and an unselected Enter key faithful to
    // the progressive-enhancement contract: they submit to /kb.
    close()
  })

  document.addEventListener('pointerdown', (event) => {
    if (!panel.hidden && event.target instanceof Node && !form.contains(event.target)) close()
  })
}

function focusSearch(): boolean {
  const input = document.querySelector<HTMLInputElement>('form[data-search-enhance] input[type="search"]')
  if (!input) return false
  input.focus()
  input.select()
  return true
}

function isTypingContext(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable
      || target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement)
}

function init(): void {
  const forms = document.querySelectorAll<HTMLFormElement>('form[data-search-enhance]')
  if (forms.length === 0) return
  forms.forEach(enhance)
  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      if (focusSearch()) event.preventDefault()
      return
    }
    if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !isTypingContext(event.target)) {
      if (focusSearch()) event.preventDefault()
    }
  })
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
else init()
