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
