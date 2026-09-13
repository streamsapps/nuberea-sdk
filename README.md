# @nuberea/sdk

Client library and CLI for the [NuBerea](https://nuberea.com) biblical data platform.

Query morphological corpora, lexicons, Bible texts, manuscripts, and scrolls — via MCP tools or SQL analytics.

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

## Historical Sources network

The `historical` client provides read-only, snapshot-pinned search, passage
inspection, relationship evidence and bounded graph expansion. It uses the
same authenticated MCP connection as the other SDK tools. The server must
have a published Historical Sources snapshot enabled.

```ts
const results = await client.historical.search({
  query: 'λόγος',
  method: 'lexical',
});

const first = results.hits[0];
if (first) {
  const graph = await client.historical.expandGraph({
    graphSnapshotId: first.entry.graphSnapshotId,
    seedIds: first.entry.seedIds,
    edgeFamilies: ['recorded_reference'],
    limitNodes: 120,
    limitEdges: 240,
  });
  const source = await client.historical.getPassage({
    graphSnapshotId: graph.graphSnapshotId,
    passageVersionId: first.node.id,
  });
  console.log(source.passage.locatorLabel, source.passage.text);
  console.log(graph.page.truncated, graph.page.nextCursor);
}
```

Choose query text appropriate to the indexed source language. Use IDs from
actual results rather than constructing them from titles or Bible references.
Detail and expansion calls require the returned snapshot ID. A retired
snapshot, unavailable semantic layer, invalid response, or failed tool is an
error, not an empty successful graph.

`getRelation({ graphSnapshotId, relationId })` returns either the recorded
assertion evidence or the separately typed semantic-neighbor metadata.
Semantic cosine scores are not historical confidence or proof of influence.

Browser-safe schemas, inferred types and an injectable client are exported
without loading the SDK authentication/CLI entry point:

```ts
import {
  HistoricalClient,
  HistoricalGraphResponseSchema,
  parseHistorical,
} from '@nuberea/sdk/historical';
```

The client validates MCP `structuredContent`; it does not parse a human
summary as JSON. `HistoricalContractError` identifies invalid or inconsistent
payloads, and `HistoricalToolError` identifies a tool failure.
`parseHistoricalOperation` is the shared shape-and-identity validator used
by SDK and application adapters. It checks snapshot/root membership,
search evidence identity and semantic-edge consistency in addition to
the JSON shape.

### Shared-contract workspace development

The canonical source is [contracts.ts](src/historical/contracts.ts).
Until a new SDK version is published, sibling application repositories use
deterministically generated copies rather than an unpublished package
dependency. Their independent builds require only the public TypeBox package.

From this SDK source checkout:

```bash
npm run generate:historical-contracts
npm run check:historical-contracts
npm run verify:historical-workspace
```

Generated files carry the canonical source hash and must not be edited.
The generator also emits a native ESM contract module for the Research
child runtime, retaining TypeBox validation rather than relying on a
reduced JSON-schema interpreter. Regenerate after a contract change and
validate the SDK, MCP, chat and web consumers together.

The workspace verification command requires the MCP and web source checkouts
beside this SDK, their dependencies installed, and Node 26. It creates a
temporary, explicitly synthetic publication and exercises the real web API
client and SDK client through the actual local HTTP/MCP adapters and DuckDB.
Only authentication/entitlement inputs are mocked. It uses no cloud accounts,
hosted models, private data, or production configuration, and closes its
listeners/readers and removes its temporary publication afterward.

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
| `dss` | `scrolls` | Dead Sea Scrolls annotations | 500,991 |
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
- **`scroll_dss_*`** — Dead Sea Scrolls
- **`transcription_cntr_*`** — CNTR manuscripts
- **`synoptic_*`** — Synoptic parallels
- **`analytics_*`** — SQL queries, schema introspection

Run `nuberea tools` to see the full list.

## Configuration

### Environment Variables

| Variable | Description |
|---|---|
| `NUBEREA_BASE_URL` | API base URL (default: `https://auth.aws-dev.streamsappsgslbex.com`) |
| `NUBEREA_ACCESS_TOKEN` | Pre-set access token (skip login) |
| `NUBEREA_FIREBASE_TOKEN` | Pre-set Firebase token (skip browser sign-in) |

### Programmatic

```ts
const client = new NuBerea({
  baseUrl: 'https://auth.aws-dev.streamsappsgslbex.com',
  accessToken: 'your-token', // Skip login
});
```

## Authentication

NuBerea uses OAuth 2.1 with PKCE.

1. `nuberea login` opens your browser to `nuberea.com/login`
2. Sign in to your nuberea account
3. Tokens are stored at `~/.nuberea/tokens.json` (mode 0600)
4. Tokens auto-refresh — you rarely need to re-login

## License

MIT
