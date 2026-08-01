import type { Communications, ConversationRouteLink, ConversationRevision, ConversationWorkspace } from '../communications'
import type { Crm } from '../crm'
import type { Directory } from '../directory'
import type { Actor, Channel, Helpdesk } from '../domain/types'

export type ConversationRouteTarget = 'support' | 'sales' | 'both'

export type ConversationRouteCommand = {
  conversationId: string
  revision: ConversationRevision
  intentId: string
  target: ConversationRouteTarget
}

export type ConversationRouteResult = {
  kind: 'conversation_route'
  conversationId: string
  completed: Array<'support' | 'sales'>
  pending: Array<'support' | 'sales'>
  pendingReasons: Array<{
    target: 'support' | 'sales'
    code: 'state_changed' | 'not_authorized' | 'invalid_input' | 'dependency_unavailable'
    message: string
  }>
  nextAction: string | null
  links: ConversationRouteLink[]
  conversation: ConversationWorkspace
}

export interface ConversationRouter {
  route(actor: Actor, command: ConversationRouteCommand): Promise<ConversationRouteResult>
}

export type ConversationRouterDependencies = {
  communications: Communications
  directory: Directory
  crm: Crm
  helpdesk: Pick<Helpdesk, 'work' | 'act'>
}

function clean(value: string, label: string, maximum: number): string {
  const result = value.replaceAll('\u0000', '').trim()
  if (!result) throw new Error(`${label} is required`)
  if (result.length > maximum) throw new Error(`${label} must be ${maximum} characters or fewer`)
  return result
}

function summary(conversation: ConversationWorkspace): string {
  return conversation.messages
    .filter((message) => message.direction === 'inbound')
    .map((message) => message.body)
    .join('\n\n')
    .slice(0, 4_000)
}

function helpdeskChannel(conversation: ConversationWorkspace): Channel {
  if (conversation.channel === 'whatsapp' || conversation.channel === 'email' || conversation.channel === 'portal') {
    return conversation.channel
  }
  return 'manual'
}

function customerFor(conversation: ConversationWorkspace): { name: string; email?: string; phone?: string } {
  const { contact } = conversation
  if (contact.address.kind === 'email') return { name: contact.name, email: contact.address.value }
  if (contact.address.kind === 'phone') return { name: contact.name, phone: contact.address.value }
  return { name: contact.name }
}

function channelLabel(channel: ConversationWorkspace['channel']): string {
  if (channel === 'whatsapp') return 'WhatsApp'
  return channel === 'facebook_messenger'
    ? 'Facebook Messenger'
    : channel.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function pendingReason(target: 'support' | 'sales', error: unknown): ConversationRouteResult['pendingReasons'][number] {
  const message = error instanceof Error ? error.message : ''
  if (/changed|revision|stale/i.test(message)) {
    return { target, code: 'state_changed', message: 'The conversation changed while routing. Reload it and retry only this target.' }
  }
  if (/forbidden|authori[sz]|permission|access/i.test(message)) {
    return { target, code: 'not_authorized', message: 'The current operator is not allowed to create this target.' }
  }
  if (/requir|invalid|not found/i.test(message)) {
    return { target, code: 'invalid_input', message: 'The target could not be created from the current conversation data. Review the workspace before retrying.' }
  }
  return { target, code: 'dependency_unavailable', message: 'The target service could not complete the request. Retry only this target after it recovers.' }
}

class ExplicitConversationRouter implements ConversationRouter {
  constructor(private readonly dependencies: ConversationRouterDependencies) {}

  async route(actor: Actor, input: ConversationRouteCommand): Promise<ConversationRouteResult> {
    const conversationId = clean(input.conversationId, 'Conversation ID', 240)
    const intentId = clean(input.intentId, 'Intent ID', 240)
    const loaded = await this.dependencies.communications.work(actor, { kind: 'conversation', id: conversationId })
    if (!loaded) throw new Error('Conversation not found')
    if (loaded.resolution) throw new Error('Use morrow_conversation_reopen before routing a final no-work classification')
    let conversation: ConversationWorkspace = loaded
    const targets: Array<'support' | 'sales'> = input.target === 'both' ? ['support', 'sales'] : [input.target]
    const matchingIntent = conversation.routes.filter((route) =>
      targets.includes(route.target) && route.intentId === intentId)
    if (targets.every((target) => matchingIntent.some((route) => route.target === target))) {
      await this.reconcileDualIdentity(actor, conversation)
      return {
        kind: 'conversation_route',
        conversationId,
        completed: targets,
        pending: [],
        pendingReasons: [],
        nextAction: null,
        links: conversation.routes,
        conversation,
      }
    }
    if (conversation.revision !== input.revision && matchingIntent.length === 0) {
      throw new Error('The conversation changed; load the latest revision and try again')
    }
    const completed: Array<'support' | 'sales'> = []
    const pending: Array<'support' | 'sales'> = []
    const pendingReasons: ConversationRouteResult['pendingReasons'] = []

    for (const target of targets) {
      const existing = conversation.routes.find((route) => route.target === target)
      if (existing) {
        completed.push(target)
        continue
      }
      try {
        const link = target === 'support'
          ? await this.createSupportWork(actor, conversation, intentId)
          : await this.createSalesWork(actor, conversation, intentId)
        const receipt: { conversation: ConversationWorkspace } = await this.dependencies.communications.act(actor, {
          kind: 'attach_work',
          conversationId,
          revision: conversation.revision,
          intentId: `${intentId}:link:${target}`,
          link,
          markHandled: targets.every((requested) =>
            requested === target || conversation.routes.some((route) => route.target === requested)),
        })
        conversation = receipt.conversation
        completed.push(target)
      } catch (error) {
        pending.push(target)
        pendingReasons.push(pendingReason(target, error))
      }
    }

    await this.reconcileDualIdentity(actor, conversation)

    return {
      kind: 'conversation_route',
      conversationId,
      completed,
      pending,
      pendingReasons,
      nextAction: pending.length > 0
        ? 'Reload the conversation and retry only the pending target after addressing its reason.'
        : null,
      links: conversation.routes,
      conversation,
    }
  }

  private async reconcileDualIdentity(actor: Actor, conversation: ConversationWorkspace): Promise<void> {
    const support = conversation.routes.find((route) => route.target === 'support')
    const sales = conversation.routes.find((route) => route.target === 'sales')
    if (!support || !sales) return
    const [party, desk] = await Promise.all([
      this.dependencies.directory.work(actor, {
        kind: 'external',
        source: { module: 'communications', entityType: 'contact', entityId: conversation.contact.channelContactId },
      }),
      this.dependencies.helpdesk.work(actor, { kind: 'case', ref: support.entityId }),
    ])
    if (!party) throw new Error('Sales route has no canonical Directory party')
    if (desk.kind !== 'case') throw new Error('Support route has no Helpdesk case')
    await this.dependencies.directory.act(actor, {
      kind: 'link_external',
      intentId: `route:${conversation.id}:helpdesk-customer`,
      source: { module: 'helpdesk', entityType: 'customer', entityId: desk.customer.id },
      partyId: party.id,
    })
  }

  private async createSupportWork(actor: Actor, conversation: ConversationWorkspace, intentId: string): Promise<Omit<ConversationRouteLink, 'createdAt'>> {
    const source = { module: 'communications', entityType: 'conversation', entityId: conversation.id }
    const recovered = await this.dependencies.helpdesk.work(actor, { kind: 'source', source })
    let desk
    if (recovered.kind === 'case') {
      desk = recovered
    } else {
      const receipt = await this.dependencies.helpdesk.act(actor, {
        kind: 'open',
        customer: customerFor(conversation),
        subject: `${channelLabel(conversation.channel)} conversation with ${conversation.contact.name}`,
        body: summary(conversation),
        channel: helpdeskChannel(conversation),
        source,
      })
      if (!receipt.case) throw new Error('Helpdesk did not create a case')
      desk = receipt.case
    }
    return { target: 'support', module: 'helpdesk', entityType: 'case', entityId: desk.ref, intentId }
  }

  private async createSalesWork(
    actor: Actor,
    conversation: ConversationWorkspace,
    intentId: string,
  ): Promise<Omit<ConversationRouteLink, 'createdAt'>> {
    if (conversation.contact.address.kind === 'opaque') {
      throw new Error('Sales routing requires a verified email or phone contact address')
    }
    const source = { module: 'communications', entityType: 'conversation', entityId: conversation.id }
    const recovered = await this.dependencies.crm.salesLead(actor, { kind: 'source', source })
    if (recovered) {
      return { target: 'sales', module: 'crm', entityType: 'sales_lead', entityId: recovered.id, intentId }
    }
    const partyReceipt = await this.dependencies.directory.act(actor, {
      kind: 'adopt_external',
      intentId: `${intentId}:directory`,
      source: { module: 'communications', entityType: 'contact', entityId: conversation.contact.channelContactId },
      party: {
        kind: 'person',
        displayName: conversation.contact.name,
        contactPoints: [{
          kind: conversation.contact.address.kind,
          value: conversation.contact.address.value,
          primary: true,
        }],
      },
    })
    const leadReceipt = await this.dependencies.crm.act(actor, {
      kind: 'create_sales_lead',
      intentId: `${intentId}:sales-lead`,
      partyId: partyReceipt.party.id,
      title: `${channelLabel(conversation.channel)} inquiry from ${conversation.contact.name}`,
      summary: summary(conversation),
      source,
    })
    return { target: 'sales', module: 'crm', entityType: 'sales_lead', entityId: leadReceipt.salesLead.id, intentId }
  }
}

export function createConversationRouter(dependencies: ConversationRouterDependencies): ConversationRouter {
  return new ExplicitConversationRouter(dependencies)
}
