/**
 * NuBerea OpenClaw plugin entry point.
 *
 * Registers NuBerea biblical-data tools into the OpenClaw agent so the LLM
 * can call them directly.  Authentication reuses tokens cached at
 * ~/.nuberea/tokens.json — run `nuberea login` once before using the tools.
 *
 * Tools registered:
 *   nuberea_verse             — KJV verse lookup
 *   nuberea_bible_search      — KJV full-text search
 *   nuberea_greek_lookup      — LSJ Greek lexicon
 *   nuberea_hebrew_lookup     — BDB Hebrew lexicon (Strong's number)
 *   nuberea_greek_morphology  — Macula Greek verse morphology (Nestle 1904)
 *   nuberea_hebrew_morphology — Macula Hebrew verse morphology (WLC)
 *   nuberea_query             — SQL analytics across all biblical databases
 */

import { Type } from '@sinclair/typebox';
import { NuBerea } from './client.js';

// ---------------------------------------------------------------------------
// Shared client — created lazily, reused across tool calls
// ---------------------------------------------------------------------------

let sharedClient: NuBerea | undefined;

function getClient(): NuBerea {
  if (!sharedClient) sharedClient = new NuBerea();
  return sharedClient;
}

type ToolResponse = { content: Array<{ type: string; text: string }> };

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResponse> {
  try {
    return await getClient().tool(name, args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAuth =
      msg.includes('401') ||
      msg.toLowerCase().includes('unauthorized') ||
      msg.toLowerCase().includes('token');
    const text = isAuth
      ? 'NuBerea: not authenticated — run `nuberea login` to sign in'
      : `NuBerea error: ${msg}`;
    return { content: [{ type: 'text', text }] };
  }
}

// ---------------------------------------------------------------------------
// Plugin entry — plain object matching OpenClaw's definePluginEntry shape.
// No openclaw import needed; definePluginEntry is an identity function at
// runtime and the `openclaw` package ships only as a host-provided module.
// ---------------------------------------------------------------------------

const plugin = {
  id: 'nuberea',
  name: 'NuBerea',
  description:
    'Biblical data platform — Bible texts, Hebrew/Greek morphology, lexicons, Dead Sea Scrolls',

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(api: any): void {
    // -- Bible ---------------------------------------------------------------

    api.registerTool({
      name: 'nuberea_verse',
      description: 'Look up a KJV Bible verse by book, chapter, and verse number',
      parameters: Type.Object({
        book: Type.String({ description: 'Book name, e.g. "John"' }),
        chapter: Type.Number({ description: 'Chapter number' }),
        verse: Type.Number({ description: 'Verse number' }),
      }),
      async execute(
        _id: string,
        params: { book: string; chapter: number; verse: number },
      ): Promise<ToolResponse> {
        return callTool('bible_kjv_get_verse', params);
      },
    });

    api.registerTool({
      name: 'nuberea_bible_search',
      description: 'Search KJV Bible text for a word or phrase; returns matching verse references',
      parameters: Type.Object({
        query: Type.String({ description: 'Word or phrase to search for' }),
        limit: Type.Optional(Type.Number({ description: 'Max results (default 10)' })),
      }),
      async execute(
        _id: string,
        params: { query: string; limit?: number },
      ): Promise<ToolResponse> {
        return callTool('bible_kjv_search_text', { query: params.query, limit: params.limit ?? 10 });
      },
    });

    // -- Lexicons ------------------------------------------------------------

    api.registerTool({
      name: 'nuberea_greek_lookup',
      description: 'Look up a Greek word in the LSJ (Liddell–Scott–Jones) lexicon',
      parameters: Type.Object({
        term: Type.String({ description: 'Greek word or lemma, e.g. "λόγος"' }),
      }),
      async execute(_id: string, params: { term: string }): Promise<ToolResponse> {
        return callTool('lexicon_lsj_lookup', params);
      },
    });

    api.registerTool({
      name: 'nuberea_hebrew_lookup',
      description: "Look up a Hebrew word in the BDB lexicon by Strong's number, e.g. H1254",
      parameters: Type.Object({
        strong: Type.String({ description: "Strong's number, e.g. \"H1254\"" }),
      }),
      async execute(_id: string, params: { strong: string }): Promise<ToolResponse> {
        return callTool('lexicon_bdb_search_strong', params);
      },
    });

    // -- Morphology ----------------------------------------------------------

    api.registerTool({
      name: 'nuberea_greek_morphology',
      description:
        'Get Greek morphological analysis for a NT verse (Nestle 1904 via Macula Greek)',
      parameters: Type.Object({
        book: Type.String({ description: 'NT book name, e.g. "John"' }),
        chapter: Type.Number({ description: 'Chapter number' }),
        verse: Type.Number({ description: 'Verse number' }),
      }),
      async execute(
        _id: string,
        params: { book: string; chapter: number; verse: number },
      ): Promise<ToolResponse> {
        return callTool('macula_greek_query_verse', params);
      },
    });

    api.registerTool({
      name: 'nuberea_hebrew_morphology',
      description:
        'Get Hebrew morphological analysis for an OT verse (WLC via Macula Hebrew)',
      parameters: Type.Object({
        book: Type.String({ description: 'OT book name, e.g. "Gen"' }),
        chapter: Type.Number({ description: 'Chapter number' }),
        verse: Type.Number({ description: 'Verse number' }),
      }),
      async execute(
        _id: string,
        params: { book: string; chapter: number; verse: number },
      ): Promise<ToolResponse> {
        return callTool('macula_hebrew_query_verse', params);
      },
    });

    // -- Analytics -----------------------------------------------------------

    api.registerTool({
      name: 'nuberea_query',
      description:
        'Run a SQL analytics query against NuBerea biblical databases ' +
        '(schemas: hebrew, greek, dss, lexicons, bible). ' +
        'Returns JSON rows. Example: SELECT * FROM hebrew.morphemes WHERE book_id = \'Gen\' LIMIT 10',
      parameters: Type.Object({
        sql: Type.String({ description: 'SQL query to execute' }),
        limit: Type.Optional(Type.Number({ description: 'Row limit (default 100)' })),
      }),
      async execute(
        _id: string,
        params: { sql: string; limit?: number },
      ): Promise<ToolResponse> {
        return callTool('analytics_query', { sql: params.sql, limit: params.limit ?? 100 });
      },
    });
  },
};

export default plugin;
