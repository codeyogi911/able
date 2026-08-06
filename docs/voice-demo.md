# Browser support assistant

Morrow Desk publishes one Cloudflare-native browser support conversation as the public homepage at `/`, with text by default and optional voice input. `/voice` and `/demo/voice` redirect to that canonical route. It is not a telephone-network call and cannot place a live human into the audio session.

## User flow

1. The browser completes a session-level Turnstile check. The homepage says when secure chat is still preparing, then opens text chat without asking for a name or email. It offers task-led starts for tracking an order, delivery, warranty or repair, invoices, contacting support, and finding a private request. Each task enters a scoped conversation instead of assuming a matching help-centre article has been published; the customer describes a support issue before the app asks for an email or creates a private request.
2. For how-to, care, policy, shipping, warranty, and troubleshooting questions the agent calls `search_help_center`, answers only from the published knowledge-base articles it returns, and the UI shows matching articles under a visible "Based on" disclosure. When nothing matches, it admits the gap instead of answering from memory. Conventional search and topic browsing remain available at `/kb`.
3. Text and voice questions remain anonymous. When an order lookup, ticket, human review, or undocumented-product follow-up needs identity, the assistant shows a purpose-specific name-and-email card inside the conversation. Order lookup identifies the checkout email; a support request identifies the email used for the private case. The normalized contact is rate-limited per IP and held in per-connection state.
4. If the customer asks about a Shopify order (and Shopify is configured), the agent asks for the order number from their confirmation email and calls `get_order_status`. The server matches the number together with the session email; only an order matching **both** is returned.
5. Safety, security, payment/refund, privacy/legal, repeated-failure, and explicit-human requests stop the routine flow. If the session is still anonymous, the server preserves the pending escalation and opens exactly one human-review ticket after the contact card is completed.

The model never supplies a name or email to a tool. The Durable Object reads the server-held contact from per-connection state, attaches it to every ticket it creates, and uses the email as the second factor of every order lookup. The model asks conversationally for an order number only when it is missing.

## Trust model

The name and email collected in the conversation are **unverified contact information**. This is deliberate: ticket creation has the same trust level as the portal's public request form (unverified contact, Turnstile, and rate limits). A submitted ticket triggers follow-up email through the normal Helpdesk outbox, and the private case link in that email is what proves mailbox control later — identical to public intake.

**Order read-back** is authorized by possession of the **(order number, contact email) pair** — the same standard Shopify's own order-status lookup applies. No OTP is required for orders. The caller supplies the number; the server supplies the session's contact email; the adapter returns the order only when both match. An unknown order number and an email mismatch produce a byte-identical `not_found`, so the channel never reveals whether an order number exists for someone else's email — order-number-only lookup is forbidden because sequential numbers would otherwise be enumerable. The projection is bounded (order number, dates, statuses, line items, tracking, total) with no addresses and no payment details beyond the total; the order's email is fetched only for the server-side comparison and never returned.

The **email-OTP progressive-verification protocol** (`request_voice_verification` / `verify_voice_code`, HMAC-signed challenge, expiry, attempt caps, Turnstile action `voice_verify`) remains implemented but **dormant**: nothing triggers it today. It is reserved for future capabilities that need proof of mailbox control — ticket status read-back, which **remains excluded** from this channel, must not ship without it (or something stronger).

## Model pipeline

The browser uses `VoiceClient` from `@cloudflare/voice`. Audio travels over a WebSocket to an Agents SDK Durable Object, where Workers AI provides:

- `@cf/deepgram/flux` for streaming speech-to-text and turn detection;
- `@cf/zai-org/glm-4.7-flash` with thinking disabled for concise responses and tool selection;
- `@cf/deepgram/aura-1` for text-to-speech.

Every browser tab gets a random Durable Object instance name. The voice mixin keeps bounded conversation context in that object's SQLite storage. Ending a call, closing its WebSocket, or choosing **Start over** deletes the voice-message rows. The stated contact lasts only for the WebSocket connection.

## Agent capabilities

- answer support questions grounded in the published knowledge base via `search_help_center`, with the matching articles linked in the UI;
- create a real Helpdesk ticket addressed to the caller's stated contact;
- automatically open a ticket when the deterministic escalation policy detects a serious issue;
- speak the result and show newly created ticket references in the UI.

It cannot process refunds, report ticket status, change ticket state, access any customer's tickets, dial a phone number, prove that a human picked up, or provide a synchronous live-human transfer. Status updates reach the customer by email through their private case link.

## Local development

Workers AI voice providers require authenticated remote Workers AI access. Ticket follow-up email uses the configured Email Service binding and workspace sender settings:

```sh
npm install
npx wrangler login
npm run dev
```

Open `http://localhost:8787/`. The legacy `/voice` and `/demo/voice` routes permanently redirect there. The production flag is committed on; set `MORROW_VOICE_DEMO_ENABLED:0` as a kill switch when the channel must be withdrawn, which restores the conventional portal home.

## Conversation guardrails and evals

Ava is restricted to product, service, order, account, and existing-case support. She must treat short speech segments as possible continuations, acknowledge the customer's situation, ask at most one useful question per turn, infer internal case fields from the conversation, and explicitly stop callers from sharing secrets.

Run the compact live model suite before changing the prompt, model, or tool descriptions:

```sh
npx wrangler login
npm run eval:voice
```

The suite runs the configured production model through an isolated local Worker with fake ticket creation, order fixtures, and help-centre article fixtures. It checks support scope, fragmented ticket intake, non-repetitive and empathetic progression, truthful status-unavailable handling, one-shot ticket creation with a spoken case reference, sensitive-data refusal, order lookup (asks for the number, grounded read-back, oracle-safe not-found, honest outage copy), anonymous grounded help, in-thread contact requests, and post-contact continuation. A how-to question must call `search_help_center` and answer only from returned article content without inventing facts or URLs; a no-match search must admit the gap and offer the appropriate order or ticket path. It uses remote Workers AI and therefore consumes inference quota, but it cannot read or mutate production Helpdesk data. Deterministic fragment and secret checks also run in the normal `npm test` gate.

## Security and operations

The session is protected by Turnstile (action `voice_session`) and the public rate-limit binding, keyed per client IP. The widget uses interaction-only appearance so it stays out of the way unless the managed challenge requires input. Contact capture is separately rate-limited; ticket creation adds per-IP and per-email limits plus a durable per-email capacity ledger with request-ID replay protection. Order lookup requires the caller-supplied order number to match the session email on the order itself and reveals nothing when it does not. The dormant progressive-verification protocol (Turnstile action `voice_verify`, per-IP and per-email rate limits, HMAC-signed challenge with expiry and attempt caps; only the signature and salt — never the plaintext code — retained in connection state) stays available for future capabilities that need proof of mailbox control.

Shopify order read-back is optional and fails closed. It activates only when `SHOPIFY_SHOP_DOMAIN` plus working credentials are configured. The current auth is the OAuth **client credentials grant**: create an app for your own organization in the Shopify Dev Dashboard with only the `read_orders` scope, request Protected customer data access (Level 2, Email field), install it on the store, and store its credentials as secrets (`wrangler secret put SHOPIFY_CLIENT_ID` and `wrangler secret put SHOPIFY_CLIENT_SECRET`). The Worker exchanges them at `https://{shop}/admin/oauth/access_token` (`grant_type=client_credentials`), caches the ~24-hour access token in memory with a five-minute safety margin, refreshes it on expiry, and re-authenticates once on a rejected token. A legacy custom-app Admin token (`wrangler secret put SHOPIFY_ADMIN_TOKEN`) is still honored and skips the token endpoint. Lookups use a pinned Admin GraphQL API version, 10-second timeouts on both the token call and the query, and degrade to a typed "unavailable" result — provider errors never reach the model or the caller.

A created ticket proves only that Morrow Desk accepted the support request. It does not prove operator pickup or final resolution. Add a telephony provider and an explicit availability, queue, timeout, receipt, and fallback state machine before claiming phone calls or live transfers.

## Package policy

`@cloudflare/voice` is experimental and its upstream documentation warns that APIs can break between releases. Morrow Desk pins `@cloudflare/voice`, `agents`, AI SDK 6, and `workers-ai-provider` to tested compatible versions. Review upstream release notes and rerun the full repository gate before changing any of them.

Treat end-to-end latency as a measured release property. Capture model, speech, tool, network, and rendering timings without retaining customer content; optimize only against reproducible traces.
