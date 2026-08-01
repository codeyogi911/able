type EmailFixture = {
  from?: string
  to?: string
  subject: string
  messageId: string
  text: string
  headers?: Record<string, string>
  attachment?: {
    filename: string
    contentType: string
    content: string
  }
}

function lines(values: string[]): string {
  return `${values.join('\r\n')}\r\n`
}

export function emailFixture(input: EmailFixture): string {
  const headers = [
    `From: ${input.from ?? 'Avery Customer <avery@example.test>'}`,
    `To: ${input.to ?? 'support@example.test'}`,
    `Subject: ${input.subject}`,
    `Message-ID: ${input.messageId}`,
    'Date: Fri, 17 Jul 2026 12:00:00 +0000',
    'MIME-Version: 1.0',
    ...Object.entries(input.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
  ]

  if (!input.attachment) {
    return lines([
      ...headers,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      input.text,
    ])
  }

  const boundary = 'morrow-test-boundary-7d15c8'
  return lines([
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    input.text,
    `--${boundary}`,
    `Content-Type: ${input.attachment.contentType}; name="${input.attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${input.attachment.filename}"`,
    '',
    btoa(input.attachment.content),
    `--${boundary}--`,
    '',
  ])
}

export class ForwardableEmailFixture implements ForwardableEmailMessage {
  readonly from: string
  readonly to: string
  readonly headers: Headers
  readonly raw: ReadableStream<Uint8Array>
  readonly rawSize: number
  rejectReason: string | null = null

  constructor(source: string, from = 'avery@example.test', to = 'support@example.test') {
    const bytes = new TextEncoder().encode(source)
    this.from = from
    this.to = to
    this.headers = new Headers()
    this.rawSize = bytes.byteLength
    this.raw = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
  }

  setReject(reason: string): void {
    this.rejectReason = reason
  }

  forward(): Promise<EmailSendResult> {
    return Promise.reject(new Error('Forwarding is outside this fixture'))
  }

  reply(): Promise<EmailSendResult> {
    return Promise.reject(new Error('Replying is outside this fixture'))
  }
}
