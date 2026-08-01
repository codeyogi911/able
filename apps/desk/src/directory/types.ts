import type { Actor } from '../domain/types'

declare const partyRevisionBrand: unique symbol
export type PartyRevision = string & { readonly [partyRevisionBrand]: true }

export type PartyKind = 'person' | 'organization'
export type ContactPointKind = 'email' | 'phone'

export type ExternalIdentity = {
  module: string
  entityType: string
  entityId: string
}

export type PartyWorkspace = {
  kind: 'party'
  id: string
  partyKind: PartyKind
  displayName: string
  revision: PartyRevision
  contactPoints: Array<{
    id: string
    kind: ContactPointKind
    value: string
    primary: boolean
  }>
  externalLinks: ExternalIdentity[]
  createdAt: string
  updatedAt: string
}

export type DirectorySelector =
  | { kind: 'party'; partyId: string }
  | { kind: 'external'; source: ExternalIdentity }

export type DirectoryCommand =
  | {
      kind: 'adopt_external'
      intentId: string
      source: ExternalIdentity
      party: {
        kind: PartyKind
        displayName: string
        contactPoints: Array<{
          kind: ContactPointKind
          value: string
          primary?: boolean
        }>
      }
    }
  | { kind: 'link_external'; intentId: string; source: ExternalIdentity; partyId: string }

export type DirectoryReceipt = {
  operationId: string
  replayed: boolean
  created: boolean
  party: PartyWorkspace
}

export interface Directory {
  work(actor: Actor, selector: DirectorySelector): Promise<PartyWorkspace | null>
  act(actor: Actor, command: DirectoryCommand): Promise<DirectoryReceipt>
}
