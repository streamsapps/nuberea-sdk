const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { mkdtemp, readdir, unlink, rmdir } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');

const root = resolve(__dirname, '..', '..');
const mcpRoot = join(root, 'nuberea-mcp-auth');
const requireMcp = createRequire(join(mcpRoot, 'package.json'));
process.chdir(mcpRoot);
process.env.TS_NODE_PROJECT = join(mcpRoot, 'tsconfig.json');
requireMcp('./test/mocha-env.js');
requireMcp('ts-node').register({
  project: process.env.TS_NODE_PROJECT,
  transpileOnly: true,
  compilerOptions: { rootDir: root },
});
requireMcp('tsconfig-paths/register');

const express = requireMcp('express');
const { Client, InMemoryTransport } = requireMcp('@modelcontextprotocol/client');
const { historicalFixture } = requireMcp('./src/macula/historical/fixtures.ts');
const { publishLocalPreparedSnapshot } = requireMcp('./src/macula/historical/materialize.ts');
const { HistoricalReaderRegistry } = requireMcp('./src/macula/historical/reader.ts');
const { HistoricalNetworkService } = requireMcp('./src/macula/historical/service.ts');
const { HistoricalCursors } = requireMcp('./src/macula/historical/cursor.ts');
const { makeHistoricalAuthorizer } = requireMcp('./src/macula/historical/access.ts');
const { makeHistoricalDataRouter } = requireMcp('./src/macula/routes/historicalRoutes.ts');
const { makeHistoricalRouter } = requireMcp('./src/historical/routes.ts');
const { MaculaClient } = requireMcp('./src/core/services/maculaClient.ts');
const { NubereaMcpServer } = requireMcp('./src/oauth/server.ts');

const accountId = 'c8d04c09-185d-5dae-872a-df423929062b';
const paid = { enforced: true, isEntitled: async id => id === accountId };
const noLimit = (_req, _res, next) => next();
const auth = (req, res, next) => {
  const token = req.get('authorization')?.replace(/^Bearer /, '');
  if (!['firebase-original', 'oauth-original'].includes(token)) {
    res.status(401).json({ code: 'INVALID_FIXTURE_TOKEN' });
    return;
  }
  req.mcpAuth = {
    token, accountId, userId: 'local-fixture-only',
    tokenType: token === 'oauth-original' ? 'oauth' : 'firebase',
    signInProvider: 'google.com',
  };
  next();
};

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'nuberea-network-stack-'));
  let registry, internal, browser, mcpServer, protocol;
  try {
    const prepared = historicalFixture();
    const oldScheme = prepared.referenceSchemes[0].id;
    prepared.referenceSchemes[0].id = 'osis';
    for (const annotation of prepared.annotations) {
      if (annotation.target.kind === 'reference' && annotation.target.reference.referenceSchemeId === oldScheme) {
        annotation.target.reference.referenceSchemeId = 'osis';
      }
    }
    for (const mapping of prepared.verifiedMappings) {
      if (mapping.reference.referenceSchemeId === oldScheme) mapping.reference.referenceSchemeId = 'osis';
    }
    const publication = await publishLocalPreparedSnapshot(prepared, join(directory, 'network.duckdb'));
    const snapshot = publication.manifest.descriptor.graphSnapshotId;
    registry = new HistoricalReaderRegistry();
    await registry.activate({ version: 1, defaultSnapshotId: snapshot, publications: [publication] });
    const service = new HistoricalNetworkService(registry, makeHistoricalAuthorizer({
      entitlement: paid,
      requireActiveAccount: async () => true,
      loadSourcePolicy: async () => ({
        version: 1, revision: 'local-integration-policy',
        sources: prepared.sources.map(({ source }) => ({
          corpusId: source.corpusId, sourceReleaseId: source.sourceReleaseId,
          read: source.corpusId !== 'fixture-hidden', semantic: false,
        })),
      }),
    }), new HistoricalCursors('synthetic-local-integration-key-not-for-production'));

    const dataApp = express();
    dataApp.use('/api/historical', makeHistoricalDataRouter({ authenticate: auth, rateLimit: noLimit, service }));
    internal = await listen(dataApp);
    class LocalClient extends MaculaClient {
      constructor(endpoint) { super(); this.baseUrl = endpoint; }
    }
    const client = new LocalClient(internal.base);
    const webApp = express();
    webApp.use('/v1/historical', makeHistoricalRouter({ authenticate: auth, rateLimit: noLimit, entitlement: paid, client }));
    browser = await listen(webApp);

    const webModule = await import(pathToFileURL(join(root, 'nuberea-web/src/lib/api/network.ts')).href);
    const web = webModule.createHistoricalApi({ baseUrl: `${browser.base}/mcp`, getIdToken: async () => 'firebase-original' });
    const query = { method: 'reference', graphSnapshotId: snapshot, referenceSchemeId: 'osis', referenceWorkId: 'John', referenceStart: '1:1' };
    const catalog = await web.catalog();
    assert.equal(catalog.defaultSnapshotId, snapshot);
    const found = await web.search(query);
    assert.equal(found.hits.length, 5);
    const graph = await web.expandGraph({ graphSnapshotId: snapshot, seedIds: found.resolvedSeedIds });
    assert.equal(graph.nodes.length, 8);
    assert.equal(graph.edges.length, 8);
    const exact = await web.getPassage({ graphSnapshotId: snapshot, passageVersionId: found.hits[0].node.id });
    assert.equal(exact.passage.id, found.hits[0].node.id);
    await web.getRelation({ graphSnapshotId: snapshot, relationId: graph.edges[0].id });
    assert.equal(JSON.stringify(graph).includes('restricted fixture'), false);

    mcpServer = new NubereaMcpServer({ entitled: true, historical: { enabled: true, caller: { token: 'oauth-original' }, client } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    protocol = new Client({ name: 'cross-repo-local-fixture', version: '1' }, { capabilities: {} });
    await Promise.all([protocol.connect(a), mcpServer.getServer().connect(b)]);
    const sdkModule = await import(pathToFileURL(join(root, 'nuberea-sdk/dist/historical/index.js')).href);
    const sdk = new sdkModule.HistoricalClient(async (name, args) => {
      const response = await protocol.callTool({ name, arguments: args });
      return {
        content: response.content.filter(item => item.type === 'text'),
        structuredContent: response.structuredContent,
        isError: response.isError,
      };
    });
    const sdkFound = await sdk.search(query);
    assert.deepEqual(sdkFound.hits.map(hit => hit.node.id), found.hits.map(hit => hit.node.id));
    const sdkGraph = await sdk.expandGraph({ graphSnapshotId: snapshot, seedIds: sdkFound.resolvedSeedIds });
    assert.deepEqual(sdkGraph.edges.map(edge => edge.id), graph.edges.map(edge => edge.id));
    await sdk.getPassage({ graphSnapshotId: snapshot, passageVersionId: sdkFound.hits[0].node.id });
    await sdk.getRelation({ graphSnapshotId: snapshot, relationId: sdkGraph.edges[0].id });
    assert.equal((await sdk.catalog()).defaultSnapshotId, snapshot);
    console.log('PASS: real web API -> public router -> original-token internal HTTP -> real DuckDB; all five operations');
    console.log('PASS: SDK HistoricalClient -> actual MCP transport/tools -> same internal HTTP and snapshot');
    console.log('PASS: five reference hits, eight visible nodes/edges, hidden source excluded, exact snapshot/IDs');
  } finally {
    await protocol?.close();
    await mcpServer?.getServer().close();
    await browser?.close();
    await internal?.close();
    await registry?.close();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) throw new Error(`Unexpected fixture artifact: ${entry.name}`);
      await unlink(join(directory, entry.name));
    }
    await rmdir(directory);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
