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

  DATA CONNECTORS (BYO-data)
    catalog tenants                      List the tenants you own
    catalog tenant-create <name>         Create a tenant
    catalog connectors <tenantId>        List a tenant's connectors
    catalog add-hf <tenantId> <repo> <table> [files...]
                                         Register a Hugging Face dataset connector
    catalog add-glue <tenantId> <region> <workgroup> [--databases a,b] [--tables a.x]
                                         Register an AWS Glue + Athena connector
    catalog validate <tenantId> <connectorId>
                                         Validate / activate a connector
    catalog tools <tenantId>             List a tenant's tools
    catalog suggest-tools <tenantId> <connectorId>
                                         Draft parameterized tools from the schema
    catalog trust-aws|trust-role|trust-verify <tenantId> [...]
                                         AWS OIDC trust steps (glue only)
    catalog hf-identity-set <tenantId> <hfUsername>
                                         Set the tenant's Hugging Face account (gated datasets)
    catalog hf-identity-verify <tenantId>
                                         Prove the HF token exchange works
    --base-url <url>         Override API base URL
    --token <token>          Use pre-set access token

  ENVIRONMENT
    NUBEREA_BASE_URL         API base URL
    NUBEREA_ACCESS_TOKEN     Pre-set access token (for CI/automation — use short-lived tokens only)
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
    useSession: !!flags.session,
  });
}

// ============================================================================
// Commands
// ============================================================================

async function cmdLogin(client: NuBerea): Promise<void> {
  console.log('Signing in to NuBerea...');
  await client.login();
  console.log('✅ Authenticated. Credentials saved to OS Keychain (or state directory).');
}

async function cmdLogout(client: NuBerea): Promise<void> {
  await client.logout();
  console.log('✅ Logged out. Credentials cleared.');
}

async function cmdStatus(client: NuBerea): Promise<void> {
  const authed = await client.checkAuth();
  if (authed) {
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
// Catalog (BYO-data) commands
// ============================================================================

function csv(value: string | boolean | undefined): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

async function cmdCatalog(
  client: NuBerea,
  args: string[],
  flags: Record<string, string | boolean>,
  raw: boolean,
): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  const out = (data: unknown): void => console.log(formatJson(data, raw));

  switch (sub) {
    case 'tenants':
      return out(await client.catalog.listTenants());

    case 'tenant-create': {
      const displayName = rest.join(' ').trim();
      if (!displayName) die('Usage: nuberea catalog tenant-create <displayName>');
      return out(await client.catalog.createTenant(displayName, flags.tier as string | undefined));
    }

    case 'tenant-delete': {
      if (!rest[0]) die('Usage: nuberea catalog tenant-delete <tenantId>');
      await client.catalog.deleteTenant(rest[0]);
      return out({ deleted: rest[0] });
    }

    case 'connectors':
      if (!rest[0]) die('Usage: nuberea catalog connectors <tenantId>');
      return out(await client.catalog.listConnectors(rest[0]));

    case 'add-hf': {
      const [tenantId, repo, tableName, ...files] = rest;
      if (!tenantId || !repo || !tableName) {
        die('Usage: nuberea catalog add-hf <tenantId> <repo> <tableName> [files...] [--auth gated] [--revision <ref>] [--hf-resource <user>]');
      }
      return out(
        await client.catalog.createHfConnector(tenantId, {
          repo,
          tableName,
          files,
          auth: flags.auth === 'gated' ? 'gated' : 'public',
          revision: flags.revision as string | undefined,
          // Seeds the tenant HF identity when unset; ignored once one exists.
          // Use `hf-identity-set` to change it.
          hfResource: flags['hf-resource'] as string | undefined,
        }),
      );
    }

    case 'add-glue': {
      const [tenantId, region, workgroup] = rest;
      if (!tenantId || !region || !workgroup) {
        die('Usage: nuberea catalog add-glue <tenantId> <region> <athenaWorkgroup> [--databases a,b] [--tables a.x,b.y]');
      }
      const databases = csv(flags.databases);
      const tables = csv(flags.tables);
      return out(
        await client.catalog.createGlueConnector(tenantId, {
          region,
          athenaWorkgroup: workgroup,
          ...(databases.length || tables.length ? { scope: { databases, ...(tables.length ? { tables } : {}) } } : {}),
        }),
      );
    }

    case 'validate': {
      const [tenantId, connectorId] = rest;
      if (!tenantId || !connectorId) die('Usage: nuberea catalog validate <tenantId> <connectorId>');
      return out(await client.catalog.validateConnector(tenantId, connectorId));
    }

    case 'connector-delete': {
      const [tenantId, connectorId] = rest;
      if (!tenantId || !connectorId) die('Usage: nuberea catalog connector-delete <tenantId> <connectorId>');
      await client.catalog.deleteConnector(tenantId, connectorId);
      return out({ deleted: connectorId });
    }

    case 'suggest-tools': {
      const [tenantId, connectorId] = rest;
      if (!tenantId || !connectorId) die('Usage: nuberea catalog suggest-tools <tenantId> <connectorId> [--max <n>] [--prompt "<text>"]');
      return out(
        await client.catalog.suggestTools(tenantId, connectorId, {
          maxSuggestions: flags.max ? parseInt(flags.max as string, 10) : undefined,
          prompt: flags.prompt as string | undefined,
        }),
      );
    }

    case 'tools':
      if (!rest[0]) die('Usage: nuberea catalog tools <tenantId>');
      return out(await client.catalog.listTools(rest[0]));

    case 'register-tool': {
      const [tenantId, json] = rest;
      if (!tenantId || !json) die('Usage: nuberea catalog register-tool <tenantId> <tool_json>');
      let input: unknown;
      try {
        input = JSON.parse(json);
      } catch {
        die(`Invalid tool JSON: ${json}`);
      }
      return out(await client.catalog.registerTool(tenantId, input as Parameters<typeof client.catalog.registerTool>[1]));
    }

    case 'trust-aws':
      if (!rest[0]) die('Usage: nuberea catalog trust-aws <tenantId>');
      return out(await client.catalog.createAwsTrust(rest[0]));

    case 'trust-role': {
      const [tenantId, roleArn] = rest;
      if (!tenantId || !roleArn) die('Usage: nuberea catalog trust-role <tenantId> <roleArn>');
      return out(await client.catalog.setTrustRoleArn(tenantId, roleArn));
    }

    case 'trust-verify':
      if (!rest[0]) die('Usage: nuberea catalog trust-verify <tenantId>');
      return out(await client.catalog.verifyAwsTrust(rest[0]));

    case 'hf-identity':
      if (!rest[0]) die('Usage: nuberea catalog hf-identity <tenantId>');
      return out(await client.catalog.getHfIdentity(rest[0]));

    case 'hf-identity-set': {
      const [tenantId, hfUsername] = rest;
      if (!tenantId || !hfUsername) die('Usage: nuberea catalog hf-identity-set <tenantId> <hfUsername>');
      return out(await client.catalog.setHfIdentity(tenantId, hfUsername));
    }

    case 'hf-identity-verify':
      if (!rest[0]) die('Usage: nuberea catalog hf-identity-verify <tenantId>');
      return out(await client.catalog.verifyHfIdentity(rest[0]));

    default:
      die(
        'Usage: nuberea catalog <subcommand>\n' +
          '  tenants | tenant-create <name> | tenant-delete <id>\n' +
          '  connectors <tenantId> | add-hf <tenantId> <repo> <table> [files...] | add-glue <tenantId> <region> <wg>\n' +
          '  validate <tenantId> <connectorId> | connector-delete <tenantId> <connectorId>\n' +
          '  suggest-tools <tenantId> <connectorId> | tools <tenantId> | register-tool <tenantId> <json>\n' +
          '  trust-aws <tenantId> | trust-role <tenantId> <roleArn> | trust-verify <tenantId>\n' +
          '  hf-identity <tenantId> | hf-identity-set <tenantId> <hfUsername> | hf-identity-verify <tenantId>',
      );
  }
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
  if (!flags.token && !process.env.NUBEREA_ACCESS_TOKEN && !await client.checkAuth()) {
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
    case 'catalog':
      return cmdCatalog(client, args, flags, raw);
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
