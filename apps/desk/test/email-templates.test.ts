import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from '../src/domain/types'
import {
  loadEmailCustomization,
  prepareEmailNotification,
  updateEmailCustomization,
} from '../src/email/templates'

const owner: Actor = {
  id: 'email-template-owner',
  email: 'owner@example.test',
  name: 'Email Template Owner',
  role: 'admin',
}

describe('agent-controlled customer email notifications', () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `INSERT INTO operators (id, email, name, role) VALUES (?, ?, ?, 'admin')`,
    ).bind(owner.id, owner.email, owner.name).run()
  })

  it('renders rich, escaped email from validated brace placeholders', async () => {
    await updateEmailCustomization(env.DB, 'case_received', {
      subjectTemplate: 'Welcome {{customer_name}} — {{case_ref}}',
      bodyTextTemplate: 'Hi {{customer_name}}, open {{case_link}}.',
      bodyMarkdownTemplate: '# Request {{case_ref}}\n\nHi **{{customer_name}}**.\n\n[Open your private case]({{case_link}})',
    }, owner)

    const rendered = await prepareEmailNotification(env.DB, 'case_received', {
      workspace_name: 'Example Workshop',
      customer_name: '<script>not markup</script>',
      case_ref: 'EX-42',
      case_subject: 'Group head pressure',
      case_link: 'https://support.example.test/requests/access#{{able_customer_capability}}',
      recovery_link: 'https://support.example.test/requests/recover?ref=EX-42',
    })

    expect(rendered).toMatchObject({
      subject: 'Welcome <script>not markup</script> — EX-42',
      bodyText: 'Hi <script>not markup</script>, open https://support.example.test/requests/access#{{able_customer_capability}}.',
    })
    expect(rendered?.bodyHtml).toContain('<h1>Request EX-42</h1>')
    expect(rendered?.bodyHtml).toContain('<strong>&lt;script&gt;not markup&lt;/script&gt;</strong>')
    expect(rendered?.bodyHtml).toContain('href="https://support.example.test/requests/access#%7B%7Bable_customer_capability%7D%7D"')
    expect(rendered?.bodyHtml).not.toContain('<script>')
  })

  it('lets an administrator turn one notification off without changing the others', async () => {
    await updateEmailCustomization(env.DB, 'agent_reply', { enabled: false }, owner)

    const customization = await loadEmailCustomization(env.DB)
    expect(customization.templates.find((template) => template.notification === 'agent_reply')?.enabled).toBe(false)
    expect(customization.templates.find((template) => template.notification === 'case_received')?.enabled).toBe(true)
    await expect(prepareEmailNotification(env.DB, 'agent_reply', {
      workspace_name: 'Able Desk',
      customer_name: 'Inez Almeida',
      case_ref: 'AD-731',
      case_subject: 'Pressure drops',
      message_body: 'Please check the tank.',
      case_link: 'https://support.example.test/requests/access#token',
      recovery_link: 'https://support.example.test/requests/recover?ref=AD-731',
    })).resolves.toBeNull()
  })

  it('rejects unknown placeholders before a template can be activated', async () => {
    await expect(updateEmailCustomization(env.DB, 'case_recovery', {
      subjectTemplate: 'Private link for {{case_ref}}',
      bodyMarkdownTemplate: 'Send secrets to {{unknown_value}}',
    }, owner)).rejects.toThrow('Unknown email placeholder')
  })
})
