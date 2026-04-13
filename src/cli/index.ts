#!/usr/bin/env node
/**
 * NuBerea CLI
 *
 * Command-line interface for the NuBerea biblical data platform.
 *
 * Usage:
 *   nuberea login              — Authenticate (opens browser)
 *   nuberea logout             — Clear stored credentials
 *   nuberea tools              — List available MCP tools
 *   nuberea tool <name> [json] — Call an MCP tool
 *   nuberea query <sql>        — Run a SQL analytics query
 *   nuberea databases          — List available databases
 *   nuberea describe <db> <tbl>— Describe a table
 *   nuberea introspect <schema>— Deep schema introspection
 *   nuberea verse <ref>        — Get a KJV verse (e.g., "John 1:1")
 *   nuberea search <text>      — Search KJV text
 *   nuberea greek <word>       — Look up a Greek word in LSJ
 *   nuberea hebrew <strong>    — Look up a Hebrew Strong's number in BDB
 */

import { NuBerea } from '../client.js';

// ============================================================================
// Helpers
// ============================================================================

function usage(): void {
  console.log(`
  nuberea — NuBerea biblical data platform CLI

  AUTHENTICATION
    login                    Sign in (opens browser)
    logout                   Clear stored credentials
    status                   Check authentication status

  MCP TOOLS
    tools                    List all available tools
    tool <name> [args_json]  Call a tool by name
                             e.g., nuberea tool bible_kjv_get_verse '{"book":"John","chapter":1,"verse":1}'
    resources                List available MCP resources
    resource <uri>           Read an MCP resource by URI
    mcp <method> [params]    Send a raw MCP JSON-RPC request

  ANALYTICS
    query <sql>              Execute a SQL query
    databases                List databases and tables
    describe <db> <table>    Describe table columns
    introspect <schema>      Deep schema inspection (columns, counts, samples)
    stats                    Row counts for all tables

  SHORTCUTS
    verse <book> <ch>:<vs>   Get a KJV verse
    search <text>            Search KJV text
    greek <word>             Look up Greek word in LSJ
    hebrew <strong>          Look up Hebrew Strong's number in BDB

  OPTIONS
    --json                   Output raw JSON (default: formatted)
    --limit <n>              Row limit for queries (default: 100)
    --session                Use MCP session mode (initialize + session tracking)
    --base-url <url>         Override API base URL
    --token <token>          Use pre-set access token

  ENVIRONMENT
    NUBEREA_BASE_URL         API base URL
    NUBEREA_ACCESS_TOKEN     Pre-set access token
    NUBEREA_FIREBASE_TOKEN   Pre-set Firebase token (skip browser)
`);
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  command: string;
  args: string[];
  flags: Record<string, string | boolean>;
} {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }

  return {
    command: positional[0] ?? '',
    args: positional.slice(1),
    flags,
  };
}

function formatJson(data: unknown, raw: boolean): string {
  if (raw) return JSON.stringify(data);
  return JSON.stringify(data, null, 2);
}

function createClient(flags: Record<string, string | boolean>): NuBerea {
  return new NuBerea({
    baseUrl: (flags['base-url'] as string) ?? process.env.NUBEREA_BASE_URL,
    accessToken: (flags.token as string) ?? process.env.NUBEREA_ACCESS_TOKEN,
    firebaseToken: process.env.NUBEREA_FIREBASE_TOKEN,
    useSession: !!flags.session,
  });
}

// ============================================================================
// Commands
// ============================================================================

async function cmdLogin(client: NuBerea): Promise<void> {
  console.log('Signing in to NuBerea...');
  await client.login();
  console.log('✅ Authenticated. Tokens saved to ~/.nuberea/tokens.json');
}

async function cmdLogout(client: NuBerea): Promise<void> {
  client.logout();
  console.log('✅ Logged out. Tokens cleared.');
}

async function cmdStatus(client: NuBerea): Promise<void> {
  if (client.isAuthenticated()) {
    console.log('✅ Authenticated');
  } else {
    console.log('❌ Not authenticated. Run: nuberea login');
  }
}

async function cmdTools(client: NuBerea, raw: boolean): Promise<void> {
  const tools = await client.tools();

  if (raw) {
    console.log(formatJson(tools, true));
    return;
  }

  console.log(`\n${tools.length} tools available:\n`);
  for (const tool of tools) {
    console.log(`  ${tool.name}`);
    if (tool.description) {
      const desc = tool.description.split('\n')[0].substring(0, 80);
      console.log(`    ${desc}`);
    }
  }
  console.log();
}

async function cmdTool(
  client: NuBerea,
  args: string[],
  raw: boolean,
): Promise<void> {
  const name = args[0];
  if (!name) die('Usage: nuberea tool <name> [args_json]');

  let toolArgs: Record<string, unknown> = {};
  if (args[1]) {
    try {
      toolArgs = JSON.parse(args[1]);
    } catch {
      die(`Invalid JSON: ${args[1]}`);
    }
  }

  const result = await client.tool(name, toolArgs);

  if (raw) {
    console.log(formatJson(result, true));
  } else {
    for (const content of result.content) {
      if (content.type === 'text') {
        console.log(content.text);
      }
    }
  }
}

async function cmdQuery(
  client: NuBerea,
  args: string[],
  flags: Record<string, string | boolean>,
  raw: boolean,
): Promise<void> {
  const sql = args.join(' ');
  if (!sql) die('Usage: nuberea query <sql>');

  const limit = flags.limit ? parseInt(flags.limit as string, 10) : 100;
  const result = await client.query(sql, { limit });

  if (raw) {
    console.log(formatJson(result, true));
    return;
  }

  console.log(`\n${result.rowCount} rows (${result.executionTimeMs}ms)${result.truncated ? ' [truncated]' : ''}\n`);

  if (result.rows.length === 0) return;

  // Simple table output
  const cols = result.columns;
  const widths = cols.map((c) =>
    Math.max(
      c.length,
      ...result.rows.map((r) => String(r[c] ?? '').substring(0, 60).length),
    ),
  );

  const header = cols.map((c, i) => c.padEnd(widths[i])).join(' | ');
  const separator = widths.map((w) => '-'.repeat(w)).join('-+-');
  console.log(header);
  console.log(separator);

  for (const row of result.rows) {
    const line = cols
      .map((c, i) => String(row[c] ?? '').substring(0, 60).padEnd(widths[i]))
      .join(' | ');
    console.log(line);
  }
  console.log();
}

async function cmdDatabases(client: NuBerea, raw: boolean): Promise<void> {
  const dbs = await client.databases();

  if (raw) {
    console.log(formatJson(dbs, true));
    return;
  }

  console.log(`\n${dbs.length} databases:\n`);
  for (const db of dbs) {
    const tables = db.tables.map((t) => t.table).join(', ');
    console.log(`  ${db.name.padEnd(15)} ${db.description}`);
    console.log(`  ${''.padEnd(15)} tables: ${tables}`);
  }
  console.log();
}

async function cmdDescribe(
  client: NuBerea,
  args: string[],
  raw: boolean,
): Promise<void> {
  if (args.length < 2) die('Usage: nuberea describe <database> <table>');

  const columns = await client.describe(args[0], args[1]);

  if (raw) {
    console.log(formatJson(columns, true));
    return;
  }

  console.log(`\n${args[0]}.${args[1]}:\n`);
  for (const col of columns) {
    console.log(`  ${col.column_name.padEnd(25)} ${col.column_type.padEnd(15)} ${col.null === 'YES' ? 'nullable' : ''}`);
  }
  console.log();
}

async function cmdIntrospect(
  client: NuBerea,
  args: string[],
  raw: boolean,
): Promise<void> {
  if (args.length < 1) die('Usage: nuberea introspect <schema> [table]');

  const result = await client.introspect(args[0], args[1]);

  if (raw) {
    console.log(formatJson(result, true));
    return;
  }

  console.log(`\nSchema: ${result.schema} — ${result.description}\n`);
  for (const table of result.tables) {
    console.log(`  ${table.table} (${(table.rowCount ?? 0).toLocaleString()} rows)`);
    for (const col of table.columns ?? []) {
      console.log(`    ${col.column_name.padEnd(25)} ${col.column_type}`);
    }
    if (table.sampleRows?.length) {
      console.log(`    Sample: ${JSON.stringify(table.sampleRows[0]).substring(0, 120)}...`);
    }
    console.log();
  }
}

async function cmdVerse(client: NuBerea, args: string[], raw: boolean): Promise<void> {
  // Parse "John 1:1" or "John" "1:1" or "John" "1" "1"
  const joined = args.join(' ');
  const match = joined.match(/^(.+?)\s+(\d+):(\d+)$/);
  if (!match) die('Usage: nuberea verse <book> <chapter>:<verse>  (e.g., "John 1:1")');

  const [, book, chapter, verse] = match;
  const text = await client.verse(book, parseInt(chapter, 10), parseInt(verse, 10));

  if (raw) {
    console.log(text);
  } else {
    console.log(`\n${text}\n`);
  }
}

async function cmdSearch(client: NuBerea, args: string[], raw: boolean): Promise<void> {
  const text = args.join(' ');
  if (!text) die('Usage: nuberea search <text>');
  const result = await client.search(text);
  if (raw) {
    console.log(result);
  } else {
    console.log(`\n${result}\n`);
  }
}

async function cmdGreek(client: NuBerea, args: string[], raw: boolean): Promise<void> {
  const word = args[0];
  if (!word) die('Usage: nuberea greek <word>');
  const result = await client.greekLookup(word);
  if (raw) {
    console.log(result);
  } else {
    console.log(`\n${result}\n`);
  }
}

async function cmdHebrew(client: NuBerea, args: string[], raw: boolean): Promise<void> {
  const strong = args[0];
  if (!strong) die('Usage: nuberea hebrew <strong_number>');
  const result = await client.hebrewStrong(strong);
  if (raw) {
    console.log(result);
  } else {
    console.log(`\n${result}\n`);
  }
}

async function cmdResources(client: NuBerea, raw: boolean): Promise<void> {
  const resources = await client.resources();

  if (raw) {
    console.log(formatJson(resources, true));
    return;
  }

  console.log(`\n${resources.length} resources:\n`);
  for (const r of resources) {
    console.log(`  ${r.uri}`);
    if (r.description) {
      console.log(`    ${r.description.substring(0, 80)}`);
    }
  }
  console.log();
}

async function cmdResource(client: NuBerea, args: string[], raw: boolean): Promise<void> {
  const uri = args[0];
  if (!uri) die('Usage: nuberea resource <uri>');

  const contents = await client.resource(uri);

  if (raw) {
    console.log(formatJson(contents, true));
    return;
  }

  for (const content of contents) {
    console.log(`\n--- ${content.uri} (${content.mimeType ?? 'text/plain'}) ---`);
    if (content.text) {
      console.log(content.text);
    } else if (content.blob) {
      console.log(`[binary: ${content.blob.length} bytes base64]`);
    }
  }
  console.log();
}

async function cmdMcpRaw(client: NuBerea, args: string[], raw: boolean): Promise<void> {
  const method = args[0];
  if (!method) die('Usage: nuberea mcp <method> [params_json]');

  let params: Record<string, unknown> | undefined;
  if (args[1]) {
    try {
      params = JSON.parse(args[1]);
    } catch {
      die(`Invalid JSON: ${args[1]}`);
    }
  }

  const result = await client.mcpRequest(method, params);
  console.log(formatJson(result, !raw));
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const { command, args, flags } = parseArgs(process.argv.slice(2));
  const raw = !!flags.json;

  if (!command || command === 'help' || flags.help) {
    usage();
    process.exit(0);
  }

  const client = createClient(flags);

  // Commands that don't need auth
  if (command === 'login') return cmdLogin(client);
  if (command === 'logout') return cmdLogout(client);
  if (command === 'status') return cmdStatus(client);

  // Tools listing doesn't need auth (public endpoint)
  if (command === 'tools') return cmdTools(client, raw);

  // All other commands need auth — ensure we have it
  if (!client.isAuthenticated() && !flags.token && !process.env.NUBEREA_ACCESS_TOKEN) {
    console.log('Not authenticated. Signing in...\n');
    await client.login();
  }

  switch (command) {
    case 'tool':
      return cmdTool(client, args, raw);
    case 'resources':
      return cmdResources(client, raw);
    case 'resource':
      return cmdResource(client, args, raw);
    case 'mcp':
      return cmdMcpRaw(client, args, raw);
    case 'query':
    case 'sql':
      return cmdQuery(client, args, flags, raw);
    case 'databases':
    case 'dbs':
      return cmdDatabases(client, raw);
    case 'describe':
    case 'desc':
      return cmdDescribe(client, args, raw);
    case 'introspect':
      return cmdIntrospect(client, args, raw);
    case 'verse':
      return cmdVerse(client, args, raw);
    case 'search':
      return cmdSearch(client, args, raw);
    case 'greek':
      return cmdGreek(client, args, raw);
    case 'hebrew':
      return cmdHebrew(client, args, raw);
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
