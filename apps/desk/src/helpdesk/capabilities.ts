import { HelpdeskError } from './errors'

const encoder = new TextEncoder()

export const CUSTOMER_CAPABILITY_PLACEHOLDER = '{{morrow_customer_capability}}'
export const ENCODED_CUSTOMER_CAPABILITY_PLACEHOLDER = encodeURIComponent(CUSTOMER_CAPABILITY_PLACEHOLDER)

export async function deriveCustomerCapability(secret: string, casePublicId: string, nonce: string): Promise<string> {
  if (secret.length < 32) {
    throw new HelpdeskError('configuration_error', 'Customer capability secret is missing or too short', 503)
  }
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`morrow:customer:v1:${casePublicId}:${nonce}`))
  let binary = ''
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export async function materializeCustomerCapability(
  template: string,
  input: { secret: string; casePublicId: string; nonce: string },
): Promise<string> {
  if (!template.includes(CUSTOMER_CAPABILITY_PLACEHOLDER) && !template.includes(ENCODED_CUSTOMER_CAPABILITY_PLACEHOLDER)) return template
  const capability = await deriveCustomerCapability(input.secret, input.casePublicId, input.nonce)
  return template
    .replaceAll(CUSTOMER_CAPABILITY_PLACEHOLDER, capability)
    .replaceAll(ENCODED_CUSTOMER_CAPABILITY_PLACEHOLDER, capability)
}
