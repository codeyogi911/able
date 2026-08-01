export const MORROW_ONTOLOGY_VERSION = 'morrow-business.v1' as const

export const MORROW_ONTOLOGY_V1 = {
  version: MORROW_ONTOLOGY_VERSION,
  terms: {
    Party: 'A canonical person or organization identity owned by Directory.',
    HelpdeskCustomer: 'A module-local customer snapshot participating in a support case.',
    Case: 'A Helpdesk-owned support request and its lifecycle.',
    CrmRelationship: 'A CRM-owned lifecycle relationship between the business and one Party.',
    CrmActivity: 'An append-only CRM record of an interaction or business observation.',
    CrmFollowUp: 'A revisioned CRM commitment to perform a future action.',
    OperationClosure: 'A declared outcome contract and its sourced reconciliation observations.',
    ImprovementProposal: 'An inactive, versioned candidate change supported by retained evidence.',
  },
  relations: {
    represents: 'An explicit source link from a module-local identity to a canonical Party.',
    concernsParty: 'Connects a CRM aggregate to the Party whose relationship it owns.',
    sourcedFrom: 'Connects derived context or an activity to its evidence coordinate.',
    closesOperation: 'Connects an authoritative outcome observation to its operation closure.',
    motivates: 'Connects retained evidence to an inactive improvement proposal.',
  },
} as const
