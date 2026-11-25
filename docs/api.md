# Chat, agents, Study and authentication

The [REST documentation](https://nuberea.com/docs/api/) describes the selected
public endpoints. The SDK defaults to production and preserves the existing MCP
and catalog interfaces.

The shared credential flow requires the coordinated auth/MCP and chat backend
branches. Deploy those first, then publish the SDK and synchronize web API docs.
Do not silently fall back to another token type when an old backend rejects it.

## Credentials and service hosts

| Surface | Production host | Credential |
|---|---|---|
| Chat and agent planning/execution | `https://api.nuberea.com/v1` | OAuth API token with chat audience/scope, or Firebase ID token |
| Native Study | `https://mcp.nuberea.com` | OAuth API token with Study audience/scope, or Firebase ID token |
| MCP and tenant catalog | `https://mcp.nuberea.com` | OAuth token with MCP audience/scope |
| OAuth/OIDC | `https://auth.nuberea.com` | Depends on the operation |

`client.login()` bootstraps OAuth through Firebase browser sign-in and keeps the
Firebase credential only in memory. The default SDK requests resource
`https://api.nuberea.com` with scopes `mcp chat study` (the corresponding
preproduction resource is `https://api.nubereappe.com`). Issued access tokens
explicitly declare the MCP, chat and Study audiences. Narrower grants include
only their corresponding audiences; `openid` adds an explicit userinfo audience
without granting any data-service audience. A legacy MCP-only token
does not acquire chat/Study access merely because it has the same issuer.

OAuth credentials are stored per issuer/resource. Upgrading from a legacy
MCP-only cache requires one new sign-in, not an attempted scope escalation via
the old refresh token. Thereafter one cached credential and one concurrent
refresh request serve chat, agents, Study and MCP/catalog across process restarts.
Before refreshing, the manager reloads any credential already rotated by another
SDK instance, avoiding reuse of a stale refresh token.
Firebase token expiry does not force another browser sign-in while the OAuth
refresh token remains valid. An already signed-in application can supply its
Firebase session for OAuth bootstrap and legacy Firebase-authenticated API calls:

```ts
const client = new NuBerea({
  getFirebaseIdToken: () => user.getIdToken(),
});
```

For short-lived automation, `firebaseIdToken` supplies a static Firebase token.
The provider takes precedence over that static value. `accessToken` is an OAuth
credential, never a Firebase credential. The caller must supply a token with
the requested service's declared audience and scope.

Chat follows `baseUrl` / `NUBEREA_BASE_URL`; `chatBaseUrl` overrides its REST
base, including `/v1`. Study follows the MCP host. New chat, Study and OAuth
clients allow HTTPS, or HTTP loopback for local testing.

## Chat

```ts
const result = await client.chat({
  gptModel: '5.6 terra',
  userMessage: 'Assess whether these reports provide independent evidence.',
  enabledCollections: [],
  responseFormat: 'markdown',
}, {
  onChunk: (chunk) => process.stdout.write(chunk),
  onReasoningSkills: (skills) => console.error(skills),
  onToolCallStart: (tool) => console.error(tool.toolName),
});
```

`chat()` returns the full `done` payload. Skill activity remains separate from
tool calls: `onReasoningSkills` receives `{ instructionId, version, title }`
records, also preserved in `result.reasoningSkills`. The API selects skills
from the task; clients do not invoke them by ID. No selection, including a
routing timeout or low-confidence fallback, means no skill event or metadata.

Callbacks also include `onToolCall`, `onThinking` and `onEvent(event, data)`.
Use `signal` for request cancellation. HTTP failures, SSE errors, malformed
events and streams without `done` reject instead of returning partial success.
`ChatError` preserves the API code, status and details. Requests are not retried.

To continue ordinary provider-backed context, pass the actual returned
`responseID` as `previous_response_id`.

### Read-only conversation scope

Chat and both agent routes reject `conversationId` and unrecognized top-level
fields before credential/network work. Managed conversation modes can write
Firebase history/revisions, even during planning, and are deliberately excluded.
This restriction concerns Firebase conversation data, not provider response
state, authentication maintenance or AWS-backed quotas.

### Ephemeral files

Chat and agents accept `attachments` containing exactly `name`, `mediaType` and
`contentBase64`. File uploads require Plus.

```ts
await client.chat({
  gptModel: '5.6 terra',
  userMessage: 'Summarize this supplied evidence.',
  attachments: [{
    name: 'notes.txt',
    mediaType: 'text/plain',
    contentBase64: Buffer.from('The committee met in May.').toString('base64'),
  }],
});
```

Supported media types are PDF, plain text, Markdown, JSON, CSV and TSV. Limits:
five files, 10 MiB aggregate decoded content, 4 MiB per PDF, 10 MiB per other
file and a 15 MiB JSON body. Metadata, canonical padded base64 and byte limits
are checked before credential work. The server validates extraction without
silently truncating evidence.

Files last only for that request. Attachment turns ignore `previous_response_id`
and return an empty continuation ID; reattach files for subsequent questions.
`sources` digest provenance is not a reusable file reference. Persistent
`libraryFileIds` and managed YouTube imports are not supported.

## Agents

```ts
const planned = await client.agent.plan({
  gptModel: '5.6 terra',
  userMessage: 'Plan an assessment of the supplied claims.',
  enabledCollections: [],
}, {
  onPlan: ({ plan }) => console.log(plan),
  onNeedsInput: ({ inputRequests }) => console.log(inputRequests),
});

// After explicit approval and answers to any planned.inputRequests:
const result = await client.agent.run({
  gptModel: '5.6 terra',
  userMessage: 'Assess the supplied claims.',
  enabledCollections: [],
  plan: planned.plan,
  maxTurns: 4,
}, {
  onChunk: (chunk) => process.stdout.write(chunk),
  onStep: (step) => console.error(step),
});
```

Both routes require Plus. Planning handles SSE `thinking`, `plan`,
`needs_input` and `done`; private plan response IDs may be null. Execution
also handles tool/step activity. Approval, execution and retries are never
automatic. Both support the same read-only conversation and file boundaries.

## Native Study

```ts
const passage = await client.study.verse({
  corpus: 'greek', book: 'John', chapter: 1, verse: 1,
});
const dictionary = await client.study.greekLexicon({ lemma: 'λόγος' });
const domain = await client.study.greekSemanticDomain('033');
```

These read-only GETs require paid access and an appropriately scoped API token
or a signed-in Firebase account. They do
not invoke an LLM or substitute fixtures on failure. Corpora include Greek,
Hebrew, LXX and feature-gated Latin. Chapter/verse bounds are 1–150 / 1–200.
Preserve `token_id` identity (Hebrew morphemes can share a ref), attribution,
machine-annotation status and the lexical-candidate/sense boundary.

## MCP and tenant catalog

Discovery remains client-driven through `tools()`, `resources()` and
`resourceTemplates()`. Template discovery follows cursors to return all pages.
Use `tool(name, args)`, `resource(uri)` and `mcpRequest(method, params)` for the
current caller-visible catalog. `mcpNotify` sends notifications without an ID.
Tool metadata/results retain `outputSchema`, `structuredContent` and `_meta`.
MCP is sessionless; `close()` clears local state, not a server session.

All tenant operations remain on `client.catalog`, including AWS-backed
management mutations. HF creation/testing supports additional `relations`;
updates support `hfResource`. Only missing AWS trust (404) becomes null.
Other errors remain explicit `ApiError` values with status/code/details.

## Standard OAuth/OIDC

```ts
const metadata = await client.oauth.metadata();
const openid = await client.oauth.metadata('openid');
const keys = await client.oauth.jwks();
const resource = await client.oauth.protectedResource();
```

Discovery is public and does not trigger login. Low-level `authorize`, `token`,
`register` and `userinfo` methods expose the standard routes; partner, health
and platform-verification routes are excluded.

`createPkce()` generates a verifier/challenge. Authorization requires S256 and
explicit state/resource; it does not follow redirects and validates the returned
target/state/issuer. `token()` form-encodes public-client code/refresh grants and
returns credentials without replacing cached SDK login state. Never
automatically retry an uncertain rotating refresh-token exchange. The credential
manager coalesces refresh calls, validates token responses and propagates
refresh failures without silently opening a browser. Use `login()` explicitly
when reauthentication is required. Logout invalidates in-flight acquisitions
and clears this issuer/resource's persisted credentials.
Pending browser callback listeners are closed on logout, and callback state is
bound to the active sign-in so an old browser tab cannot complete a new session.
This is local logout; it does not invent a server-wide token-revocation endpoint.

`userinfo` requires `openid`; email claims additionally require `email`.
Configure `auth: { scopes: ['mcp', 'chat', 'study', 'openid', 'email'] }` before
browser login to add identity scopes while retaining API access. Explicit scope
configuration is respected; the SDK does not silently add permissions. The `method` option
supports GET or POST.

The current registration endpoint returns metadata without durable client
registration; its returned management URI is not an implemented management
endpoint. The SDK never automatically registers clients.

## Synchronizing the REST specification

From an SDK source checkout, after building:

```sh
npm run build
node scripts/sync-openapi.mjs /path/to/nuberea-web/src/data/openapi.json
```

The generator exports shared schemas and selected route contracts with their
individual hosts/authentication. It does not publish or deploy the website.
