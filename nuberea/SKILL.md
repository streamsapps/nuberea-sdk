---
name: nuberea
description: Query biblical research data — Hebrew/Greek morphology, lexicons (LSJ, BDB), Bible texts (KJV), Dead Sea Scrolls, manuscripts, and synoptic parallels — via the NuBerea MCP data platform. Use when working with biblical languages, morphological analysis, lexicon lookups, scripture text retrieval, cross-database analytics on biblical datasets, or when a user asks about NuBerea. Requires npm package @nuberea/sdk.
---

# NuBerea

Biblical data platform SDK. 1.9M rows across 10 datasets — Hebrew/Greek morphology, lexicons, Bible texts, manuscripts, scrolls — queryable via MCP tools or SQL analytics.

## Install

```bash
npm install -g @nuberea/sdk
```

## Authentication

```bash
# Interactive (opens browser for Firebase sign-in)
nuberea login

# Or set token for scripts/CI
export NUBEREA_ACCESS_TOKEN=<token>
```

Tokens persist at `~/.nuberea/tokens.json` and auto-refresh.

## CLI Quick Reference

```bash
# List all 57 MCP tools
nuberea tools

# Call any tool
nuberea tool bible_kjv_get_verse '{"book":"John","chapter":1,"verse":1}'

# Shortcuts
nuberea verse John 1:1
nuberea search "In the beginning"
nuberea greek λόγος
nuberea hebrew H430

# SQL analytics (cross-database joins)
nuberea query "SELECT h.lemma, b.short_def FROM hebrew.morphemes h JOIN bdb.entries b ON h.strong = b.strong WHERE h.book_id = 'Gen' AND h.chapter = 1 LIMIT 10"

# Schema discovery
nuberea databases
nuberea describe hebrew morphemes
nuberea introspect lsj

# MCP protocol operations
nuberea resources
nuberea resource macula://hebrew
nuberea mcp tools/list

# Raw JSON output (for piping)
nuberea tool bible_kjv_search_text '{"query":"love","limit":3}' --json
```

## Library Usage

```ts
import { NuBerea } from '@nuberea/sdk';

const client = new NuBerea();
await client.login();

// Typed convenience methods
const verse = await client.verse('John', 1, 1);
const greek = await client.greekLookup('λόγος');
const hebrew = await client.hebrewStrong('H430');

// Call any MCP tool
const result = await client.tool('macula_greek_query_verse', {
  book: 'John', chapter: 1, verse: 1,
});

// SQL analytics with cross-database joins
const rows = await client.query(`
  SELECT h.text, h.lemma, h.strong, b.short_def
  FROM hebrew.morphemes h
  LEFT JOIN bdb.entries b ON h.strong = b.strong
  WHERE h.book_id = 'Gen' AND h.chapter = 1 AND h.verse = 1
`);

// MCP resources
const resources = await client.resources();
const content = await client.resource('macula://hebrew');

// Schema discovery
const dbs = await client.databases();
const cols = await client.describe('hebrew', 'morphemes');
const info = await client.introspect('lsj');
```

## Databases

| Schema | Table | Description | Rows |
|---|---|---|---|
| `hebrew` | `morphemes` | Hebrew Bible morphological analysis (Macula) | 467,770 |
| `greek` | `morphemes` | Greek NT morphological analysis (Macula) | 137,741 |
| `lxx` | `morphemes` | Septuagint (LXX) morphological analysis | 623,693 |
| `lsj` | `entries` | Liddell-Scott-Jones Greek Lexicon | 119,553 |
| `bdb` | `entries` | Brown-Driver-Briggs Hebrew Lexicon | 10,221 |
| `abbott_smith` | `entries` | Abbott-Smith NT Greek Lexicon | 555 |
| `kjv` | `verses` | King James Version Bible text | 36,821 |
| `cntr` | `transcriptions` | CNTR Greek NT manuscript transcriptions | 41,956 |
| `dss` | `scrolls` | Dead Sea Scrolls word annotations | 500,991 |
| `aland` | `pericopes` | Synoptic parallel pericopes (Aland) | 330 |

## Tool Collections

57 MCP tools organized by prefix. See full list with `nuberea tools`.

- **`bible_kjv_*`** — get_verse, get_chapter, get_verse_range, search_text, run_sql
- **`macula_hebrew_*`** — query_verse, search_lemma, search_strong, search_word, run_sql
- **`macula_greek_*`** — same as hebrew but for Greek NT
- **`macula_lxx_*`** — same for Septuagint
- **`lexicon_lsj_*`** — lookup, search, search_latin, search_definition, search_strong
- **`lexicon_bdb_*`** — lookup, search_strong, search_transliteration, search_definition
- **`lexicon_abbott_smith_*`** — lookup, search_strong, search_definition
- **`scroll_dss_*`** — get_scroll, get_fragment, search_lemma, list_scrolls
- **`transcription_cntr_*`** — get_verse, list_manuscripts
- **`synoptic_*`** — find_parallels, find_parallels_range, search, list_pericopes
- **`analytics_*`** — query (SQL), list_databases, describe_table, schema_introspect

## Example Workflows

### Analyze a Hebrew word across the Bible

```bash
# Find all occurrences of a lemma
nuberea tool macula_hebrew_search_lemma '{"lemma":"חֶסֶד","limit":20}'

# Or via SQL for aggregated analysis
nuberea query "SELECT book_id, COUNT(*) as uses FROM hebrew.morphemes WHERE lemma = 'חֶסֶד' GROUP BY book_id ORDER BY uses DESC"
```

### Compare Greek NT with Septuagint

```bash
nuberea query "
  SELECT g.lemma, g.gloss, COUNT(*) as nt_uses,
    (SELECT COUNT(*) FROM lxx.morphemes l WHERE l.lemma = g.lemma) as lxx_uses
  FROM greek.morphemes g
  WHERE g.book_id = 'John' AND g.chapter = 1
  GROUP BY g.lemma, g.gloss
  ORDER BY nt_uses DESC
  LIMIT 15
"
```

### Cross-reference morphology with lexicon

```bash
nuberea query "
  SELECT g.text, g.lemma, g.gloss, l.definition_text
  FROM greek.morphemes g
  LEFT JOIN lsj.entries l ON g.lemma = l.headword
  WHERE g.book_id = 'Rom' AND g.chapter = 8 AND g.verse = 28
  ORDER BY g.word_position
"
```
