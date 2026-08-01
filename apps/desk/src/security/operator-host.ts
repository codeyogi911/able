export type RequestSurface = 'local' | 'operator' | 'public' | 'unconfigured'

export function isLocalUrl(url: URL): boolean {
  return url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]'
    || url.hostname === '::1'
    || url.hostname.endsWith('.localhost')
}

/**
 * Accept a bare DNS hostname only. Schemes, paths, ports and wildcard hostnames
 * are deliberately rejected because Access Managed OAuth protects a hostname.
 */
export function normalizeOperatorHostname(value?: string): string | null {
  const candidate = value?.trim().toLowerCase()
  if (!candidate || candidate.length > 253 || candidate.endsWith('.') || candidate.includes('://')) return null
  const labels = candidate.split('.')
  if (labels.length < 2) return null
  if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null
  if (!/[a-z]/.test(labels.at(-1) ?? '')) return null

  try {
    const parsed = new URL(`https://${candidate}`)
    return parsed.hostname === candidate && parsed.origin === `https://${candidate}` ? candidate : null
  } catch {
    return null
  }
}

export function requestSurface(url: URL, configuredHostname?: string): RequestSurface {
  if (isLocalUrl(url)) return 'local'
  const hostname = normalizeOperatorHostname(configuredHostname)
  if (!hostname) return 'unconfigured'
  return url.hostname.toLowerCase() === hostname ? 'operator' : 'public'
}
