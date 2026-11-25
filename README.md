# @nuberea/sdk

Client library and CLI for the [NuBerea](https://nuberea.com) biblical data platform.

Query morphological corpora, lexicons, Bible texts, manuscripts, and scrolls — via MCP tools or SQL analytics.
Send normal streaming chat turns, including tool activity and applied reasoning-skill metadata.

## Install

```bash
npm install @nuberea/sdk

# Or globally for the CLI
npm install -g @nuberea/sdk
```

## Quick Start

### As a library

```ts
import { NuBerea } from '@nuberea/sdk';

const client = new NuBerea();
await client.login(); // Opens browser for sign-in

// Get a verse
const verse = await client.verse('John', 1, 1);
console.log(verse);

// Call any MCP tool
const result = await client.tool('macula_greek_query_verse', {
  book: 'John', chapter: 1, verse: 1,
});
console.log(result.content[0].text);

// Run SQL analytics (cross-database joins)
const rows = await client.query(`
  SELECT h.text, h.lemma, h.strong, b.short_def
  FROM hebrew.morphemes h
  LEFT JOIN bdb.entries b ON h.strong = b.strong
  WHERE h.book_id = 'Gen' AND h.chapter = 1 AND h.verse = 1
  ORDER BY h.word_position
`);
console.log(rows.rows);
```

### As a CLI

```bash
# Authenticate
nuberea login

# Get a verse
nuberea verse John 1:1

# Search KJV text
nuberea search "In the beginning"

# Look up Greek word
nuberea greek λόγος

# Look up Hebrew Strong's number
nuberea hebrew H430

# List available tools
nuberea tools

# Call any tool
nuberea tool bible_kjv_get_verse '{"book":"John","chapter":1,"verse":1}'

# Run SQL query
nuberea query "SELECT * FROM hebrew.morphemes WHERE book_id = 'Gen' AND chapter = 1 LIMIT 5"

# Explore databases
nuberea databases
nuberea describe hebrew morphemes
nuberea introspect lsj

# Raw JSON output
nuberea tool bible_kjv_search_text '{"query":"love","limit":3}' --json
```

## Data connectors (BYO-data)

Register your own data so it becomes queryable through the NuBerea MCP server.
A **connector** belongs to a **tenant** (your org unit); parameterized,
SELECT-only SQL **tools** are registered against it. Two kinds are supported:
`hf_dataset` (Hugging Face Parquet, public or gated) and `glue_athena` (AWS Glue
+ Athena over your own S3, via a secretless OIDC trust).

### Library

```ts
import { NuBerea } from '@nuberea/sdk';

const client = new NuBerea();
await client.login();

const tenant = await client.catalog.createTenant('My Org');

// Hugging Face dataset (no trust needed)
const connector = await client.catalog.createHfConnector(tenant.tenantId, {
  repo: 'owner/name',
  tableName: 'orders',
  files: ['default/train/*.parquet'],
});

const result = await client.catalog.validateConnector(tenant.tenantId, connector.connectorId);
console.log(result.status, result.columns);
```

#### Gated Hugging Face datasets

Gated datasets are read with a short-lived, read-only token minted through HF
[Trusted Publishers](https://huggingface.co/docs/hub/trusted-publishers). Register
NuBerea's issuer under your HF account's **Authentication settings → CI/CD
Access**, then tell the tenant which account to use. The account is stored once
per tenant, so every gated connector under it shares one identity.

```ts
// The exact values to paste into HF. Available before an identity exists.
const setup = await client.catalog.getHfSetup(tenant.tenantId);
// { issuer, audience: 'https://huggingface.co', subject: 'tenant:<id>:workload:hf' }

await client.catalog.setHfIdentity(tenant.tenantId, 'your-hf-username');

const check = await client.catalog.verifyHfIdentity(tenant.tenantId);
if (check.status !== 'active') throw new Error(check.reason);

await client.catalog.createHfConnector(tenant.tenantId, {
  repo: 'owner/gated-name',
  tableName: 'lexicon',
  files: ['data/train/*.parquet'],
  auth: 'gated',
});
```

Private repos are not supported: Trusted-Publisher tokens can read gated repos
you have access to, but never private ones.

If you rename your Hugging Face account, call `setHfIdentity` again — one write
fixes every gated connector, because the username is stored per tenant rather
than per connector.

#### Changing an existing connector

`updateHfConnector` changes a connector's auth mode, revision or files while
leaving its registered tools intact — useful when a repo flips from public to
gated. `repo` and `tableName` are deliberately not updatable: tools select FROM
the table name and were validated against that dataset's columns, so pointing
elsewhere means creating a new connector.

The connector returns to `pending` (which hides its tools from discovery), so
validate straight after:

```ts
await client.catalog.updateHfConnector(tenantId, connectorId, { auth: 'gated' });
const result = await client.catalog.validateConnector(tenantId, connectorId);
```

### CLI

```bash
# tenants
nuberea catalog tenants
nuberea catalog tenant-create "My Org"

# Hugging Face dataset connector → validate
nuberea catalog add-hf <tenantId> owner/name orders "default/train/*.parquet"
nuberea catalog validate <tenantId> <connectorId>

# Gated Hugging Face: set the tenant's HF account once, then add connectors
nuberea catalog hf-identity-setup <tenantId>   # values to paste into HF CI/CD Access
nuberea catalog hf-identity-set <tenantId> your-hf-username
nuberea catalog hf-identity-verify <tenantId>
nuberea catalog add-hf <tenantId> owner/gated-name lexicon "data/train/*.parquet" --auth gated
nuberea catalog validate <tenantId> <connectorId>

# change a connector without rebuilding it (tools survive), then re-validate
nuberea catalog update-hf <tenantId> <connectorId> --auth gated
nuberea catalog validate <tenantId> <connectorId>

# AWS Glue + Athena: trust → connector → validate
nuberea catalog trust-aws <tenantId>
nuberea catalog trust-role <tenantId> arn:aws:iam::<acct>:role/<name>
nuberea catalog trust-verify <tenantId>
nuberea catalog add-glue <tenantId> us-west-2 primary --databases sales --tables sales.orders
nuberea catalog validate <tenantId> <connectorId>

# inspect or remove a connection (removal is refused while connectors still use it)
nuberea catalog trust <tenantId>
nuberea catalog hf-identity <tenantId>
nuberea catalog trust-delete <tenantId>
nuberea catalog hf-identity-delete <tenantId>

# tools
nuberea catalog suggest-tools <tenantId> <connectorId> --max 5
nuberea catalog register-tool <tenantId> '{"name":"orders_by_region", ... }'
nuberea catalog tools <tenantId>
```

## Chat

`client.chat(request, options)` sends `POST /v1/chat`, streams activity through
callbacks, and resolves to the complete `done` response. It does not invoke MCP
tools in place of chat.

```ts
import { NuBerea } from '@nuberea/sdk';

const client = new NuBerea(); // Production by default.
await client.login(); // Browser sign-in; keeps the Firebase ID token in memory.

const response = await client.chat({
  gptModel: '5.6 terra',
  userMessage: 'In this stipulated system, every A is B and some B are C. Does some A being C follow? Give a countermodel if not.',
  enabledCollections: [],
  responseFormat: 'markdown',
}, {
  onChunk: (chunk) => process.stdout.write(chunk),
  onReasoningSkills: (skills) => console.error('Applied skills:', skills),
  onToolCallStart: (tool) => console.error('Starting tool:', tool.toolName),
  onToolCall: (tool) => console.error('Tool result:', tool),
});

console.log(response.reasoningSkills);
// [{ instructionId: 'reasoning.interpretation_formal', version: '1.0.0', title: 'Interpretation and formal structure' }]

await client.chat({
  gptModel: '5.6 terra',
  userMessage: 'Revise the scope of the previous question.',
  previous_response_id: response.responseID,
});
```

The API chooses skills from the requested task; clients do not call a skill by
ID. When applied, `reasoning_skills` carries `{ instructionId, version, title }`
records before answer chunks, and `done.reasoningSkills` preserves them. No
selection (including a routing timeout or low-confidence fallback) means no
skill event and no final skill metadata. Frame revision requires a follow-up.
Skill metadata reports applied advisory instructions, not an executed MCP tool.

All current chat fields are supported: model, prior response ID, conversation ID,
collections, workflow, reasoning, passage context (including edition-native
reader targets), and `markdown` / `nuberea-rich` response formats. A managed video
conversation uses a UUID `conversationId`; its answer and skill events are
withheld until source validation succeeds. The server enforces plan restrictions
and rate limits.

File uploads require NuBerea Plus. Chat accepts request-scoped `attachments` with exactly `name`, `mediaType`,
and `contentBase64`. Supported media types are PDF, plain text, Markdown, JSON,
CSV, and TSV. Limits are five files, 10 MiB decoded in total, 4 MiB per PDF,
10 MiB per other file, and a 15 MiB JSON request body. The SDK validates metadata,
canonical padded base64, and byte limits before credential work. The server
also checks readable text and extraction limits; it never silently truncates
evidence. `libraryFileIds` is forbidden.

```ts
await client.chat({
  gptModel: '5.6 terra',
  userMessage: 'Summarize this supplied evidence.',
  attachments: [{
    name: 'notes.txt',
    mediaType: 'text/plain',
    contentBase64: Buffer.from('Source A dates the meeting to May.').toString('base64'),
  }],
});
```

File evidence lasts only for that request. Attachment turns ignore
`previous_response_id` and return an empty `responseID` to prevent continuation
of private file evidence. Reattach files explicitly for a later question;
digest provenance in `sources` is not a reusable file reference.

Chat requires a **Firebase ID token**, not `accessToken` (the MCP OAuth token).
Browser credentials are never persisted and prompt for sign-in again near
expiry. For an application already signed in with Firebase, supply a refreshing
provider instead of opening another browser:

```ts
const client = new NuBerea({
  getFirebaseIdToken: () => user.getIdToken(),
});
```

For short-lived automation, `firebaseIdToken` accepts an existing ID token.
It is the caller's responsibility to replace expired static tokens. The token
provider takes precedence over a static token. Use `chatBaseUrl` to override the
REST base, including `/v1`; HTTP is allowed only on loopback for local testing.
Chat follows the OAuth host selected by `baseUrl` or `NUBEREA_BASE_URL`: production
uses `https://api.nuberea.com/v1`; preproduction uses `https://api.nubereappe.com/v1`.

Callbacks also include `onThinking` and `onEvent(event, data)` for all JSON
events, including future event types. `signal` accepts an `AbortSignal`.
HTTP errors, SSE `error` events, malformed responses, and streams ending without
`done` reject rather than returning a partial answer as success. `ChatError`
preserves the API's `code`, HTTP `status`, and `details` when available.
Chat requests are not automatically retried.

```sh
nuberea chat '{"gptModel":"5.6 terra","userMessage":"Hello!"}'
# Complete structured response, including reasoningSkills:
nuberea chat '{"gptModel":"5.6 terra","userMessage":"Audit this inference: every A is B; some B are C; therefore some A are C."}' --json
```

The REST contract is available at [API documentation](https://nuberea.com/docs/api/)
and [OpenAPI JSON](https://nuberea.com/openapi.json).

## Available Databases

| Schema | Table | Description | Rows |
|---|---|---|---|
| `hebrew` | `morphemes` | Hebrew Bible morphological analysis | 467,770 |
| `greek` | `morphemes` | Greek NT morphological analysis | 137,741 |
| `lxx` | `morphemes` | Septuagint morphological analysis | 623,693 |
| `lsj` | `entries` | Liddell-Scott-Jones Greek Lexicon | 119,553 |
| `bdb` | `entries` | Brown-Driver-Briggs Hebrew Lexicon | 10,221 |
| `abbott_smith` | `entries` | Abbott-Smith NT Greek Lexicon | 555 |
| `kjv` | `verses` | King James Version Bible text | 36,821 |
| `cntr` | `transcriptions` | Greek NT manuscript transcriptions | 41,956 |
| `aland` | `pericopes` | Synoptic parallel pericopes | 330 |

## Available MCP Tools

55+ tools organized by collection:

- **`bible_kjv_*`** — KJV Bible text (get_verse, get_chapter, search_text, ...)
- **`macula_hebrew_*`** — Hebrew morphology (query_verse, search_lemma, search_strong, ...)
- **`macula_greek_*`** — Greek NT morphology
- **`macula_lxx_*`** — Septuagint morphology
- **`lexicon_lsj_*`** — LSJ Greek lexicon (lookup, search, search_latin, ...)
- **`lexicon_bdb_*`** — BDB Hebrew lexicon
- **`lexicon_abbott_smith_*`** — Abbott-Smith lexicon
- **`transcription_cntr_*`** — CNTR manuscripts
- **`synoptic_*`** — Synoptic parallels
- **`analytics_*`** — SQL queries, schema introspection

Run `nuberea tools` to see the full list.

## Configuration

### Environment Variables

| Variable | Description |
|---|---|
| `NUBEREA_BASE_URL` | OAuth base URL (default: `https://auth.nuberea.com`) |
| `NUBEREA_MCP_URL` | MCP transport URL (default: `https://mcp.nuberea.com/mcp`) |
| `NUBEREA_ACCESS_TOKEN` | Pre-set MCP OAuth access token (skip MCP login; not a chat credential) |
| `NUBEREA_FIREBASE_ID_TOKEN` | Pre-set Firebase ID token for CLI chat (skip browser sign-in) |
| `NUBEREA_CHAT_URL` | Chat REST base, including `/v1` (derived from `NUBEREA_BASE_URL` by default) |

### Programmatic

```ts
const client = new NuBerea({
  baseUrl: 'https://auth.nuberea.com',
  mcpUrl: 'https://mcp.nuberea.com/mcp',
  accessToken: 'your-token', // Skip login
});
```

The SDK automatically selects the branded MCP endpoint for known NuBerea
OAuth/control-plane hosts. OAuth authorization, token, issuer, and discovery
requests continue to use `baseUrl`; only MCP protocol and tool-list requests
use `mcpUrl`. Development and preproduction callers can override both URLs
explicitly.

## Authentication

MCP uses OAuth 2.1 with PKCE; normal chat uses a Firebase ID token.

1. `nuberea login` opens your browser to `nuberea.com/login`
2. Sign in to your nuberea account
3. Tokens are stored per OAuth host in the OS keychain when available, otherwise
   under the platform state directory (for example,
   `~/Library/Application Support/nuberea/tokens-auth.nuberea.com.json` on macOS).
   Firebase ID tokens remain only in memory.
4. OAuth tokens auto-refresh. Chat browser credentials require another sign-in
   near expiry; applications can supply `getFirebaseIdToken` for automatic
   Firebase refresh.

Install `@nuberea/sdk` in the consuming project or reference it through an npm
workspace/file dependency. Node.js ESM does not use `NODE_PATH` to resolve
packages from sibling directories.

## License

MIT
