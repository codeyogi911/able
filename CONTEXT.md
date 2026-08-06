# Able Desk Business Suite

Able Desk is an agent-operated business suite in which distinct business modules share verified identity and evidence without collapsing their work into one generic record.

## Language

**Conversation**:
A bounded work session of messages over one verified external channel between the business and a contact. A new inbound message after the prior session is handled begins a new Conversation while retaining the same provider identity.
_Avoid_: Ticket, case, chat session

**Message**:
One immutable inbound or outbound communication event within a Conversation.
_Avoid_: Case comment, lead note

**Route**:
An explicit, revisable decision that links a Conversation to one or more business work items.
_Avoid_: Classification label, automatic conversion

**Party**:
The canonical person or organization known to the business, independent of the roles they play.
_Avoid_: Customer, contact, account

**Case**:
A support problem or service request that requires resolution and lifecycle ownership by Desk.
_Avoid_: Conversation, ticket for every inbound message

**Sales Lead**:
A specific expression of potential buying intent that requires qualification and a next commercial action.
_Avoid_: Party, relationship, every new contact

**Relationship**:
The ongoing commercial state between the business and a Party across individual conversations, cases, and sales leads.
_Avoid_: Sales Lead, customer record
