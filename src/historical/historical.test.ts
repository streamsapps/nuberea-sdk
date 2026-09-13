import { describe, expect, it, vi } from 'vitest';
import { NuBerea } from '../client.js';
import {
  HISTORICAL_API_VERSION,
  HISTORICAL_LIMITS,
  HISTORICAL_TOOL_SCHEMAS,
  HistoricalContractError,
  HistoricalGraphRequestSchema,
  HistoricalGraphResponseSchema,
  HistoricalSearchRequestSchema,
  isHistoricalToolName,
  parseHistorical,
  parseHistoricalOperation,
  type HistoricalGraphResponse,
  type HistoricalPassage,
  type HistoricalRelationResponse,
  type HistoricalSearchResponse,
} from './contracts.js';
import { HistoricalClient, HistoricalToolError, type HistoricalToolCaller } from './client.js';
import type { ToolResult } from '../types.js';

const page = { nextCursor: null, truncated: false, reasons: [] };
const passage: HistoricalPassage = {
  id: 'p1',
  corpusId: 'pta',
  sourceReleaseId: 'source1',
  workId: 'homily',
  editionId: 'edition1',
  locatorLabel: 'section 1',
  language: 'grc',
  text: 'source text',
  textLayer: 'display',
  sourceUri: 'https://example.test/source',
  attribution: 'Test source',
  licenseUri: 'https://creativecommons.org/licenses/by/4.0/',
  previousPassageId: null,
  nextPassageId: null,
  facsimile: null,
  unresolvedReferences: [],
};

function graph(): HistoricalGraphResponse {
  return {
    apiVersion: 1,
    graphSnapshotId: 'snapshot1',
    seedIds: ['p1'],
    embeddingSpaceId: null,
    nodes: [{
      kind: 'passage',
      id: passage.id,
      corpusId: passage.corpusId,
      sourceReleaseId: passage.sourceReleaseId,
      workId: passage.workId,
      editionId: passage.editionId,
      locatorLabel: passage.locatorLabel,
      language: passage.language,
      preview: passage.text,
      previewTruncated: false,
    }, {
      kind: 'reference_anchor',
      id: 'r1',
      referenceSchemeId: 'nt',
      referenceLabel: 'John 1:1',
      locator: { workId: 'John', start: '1:1', end: null },
    }],
    edges: [{
      kind: 'recorded_reference',
      id: 'e1',
      from: 'p1',
      to: 'r1',
      predicate: 'editorial_reference',
      assertionIds: ['a1'],
    }],
    page: { nextCursor: null, truncated: false, reasons: [] },
  };
}

function transport(payload: Record<string, unknown>, isError = false) {
  return vi.fn<HistoricalToolCaller>(async () => ({
    content: [{ type: 'text', text: 'A human summary, not JSON.' }],
    structuredContent: payload,
    isError,
  }));
}

function relation(): HistoricalRelationResponse {
  return {
    apiVersion: 1, graphSnapshotId: 'snapshot1',
    edge: {
      kind: 'recorded_reference', id: 'e1', from: 'p1', to: 'r1',
      predicate: 'editorial_reference', assertionIds: ['a1'],
    },
    evidence: [{
      id: 'source-evidence1', assertionId: 'a1', corpusId: 'pta', sourceReleaseId: 'source1',
      sourceAnnotationId: 'annotation1', origin: 'publisher_annotation', locatorLabel: 'note 1',
      sourceUri: null, excerpt: 'Source reference', reviewStatus: 'publisher_recorded',
    }],
  };
}

describe('historical contracts', () => {
  it('declares the five read-only domain operations', () => {
    expect(Object.keys(HISTORICAL_TOOL_SCHEMAS)).toHaveLength(5);
    expect(HISTORICAL_API_VERSION).toBe(1);
    expect(isHistoricalToolName('historical_graph_expand')).toBe(true);
    expect(isHistoricalToolName('toString')).toBe(false);
    expect(isHistoricalToolName('graph_expand')).toBe(false);
  });

  it('requires a snapshot and explicit roots for graph requests', () => {
    expect(() => parseHistorical(HistoricalGraphRequestSchema, { seedIds: ['p1'] })).toThrow(HistoricalContractError);
    expect(() => parseHistorical(HistoricalGraphRequestSchema, { graphSnapshotId: 's1' })).toThrow(HistoricalContractError);
    expect(() => parseHistorical(HistoricalGraphRequestSchema, {
      graphSnapshotId: 's1', seedIds: [],
    })).toThrow(HistoricalContractError);
  });

  it.each([
    { seedIds: ['p1', 'p1'] },
    { seedIds: Array.from({ length: HISTORICAL_LIMITS.seeds + 1 }, (_, i) => `p${i}`) },
    { limitNodes: HISTORICAL_LIMITS.maxNodes + 1 },
    { limitEdges: HISTORICAL_LIMITS.maxEdges + 1 },
    { limitEdges: 0 },
    { limitNodes: 1.5 },
    { callerAccountId: 'forged-account' },
    { edgeFamilies: ['influence'] },
  ])('rejects malformed or excessive graph parameters: %j', extra => {
    expect(() => parseHistorical(HistoricalGraphRequestSchema, {
      graphSnapshotId: 's1', seedIds: ['p1'], ...extra,
    })).toThrow(HistoricalContractError);
  });

  it('keeps primitive arrays and nullable cursors compatible with MCP inputs', () => {
    const request = {
      graphSnapshotId: 's1',
      seedIds: ['p1'],
      neighborCorpusIds: ['pta'],
      edgeFamilies: ['recorded_reference'],
      cursor: null,
    };
    expect(parseHistorical(HistoricalGraphRequestSchema, request)).toEqual(request);
  });

  it('allows safe additive response metadata but not unknown edge kinds', () => {
    expect(parseHistorical(HistoricalGraphResponseSchema, { ...graph(), futureMetadata: 'value' })).toBeDefined();
    expect(() => parseHistorical(HistoricalGraphResponseSchema, {
      ...graph(), edges: [{ kind: 'influence', id: 'e1', from: 'p1', to: 'r1' }],
    })).toThrow(HistoricalContractError);
  });

  it('rejects a semantic score outside cosine range', () => {
    expect(() => parseHistorical(HistoricalGraphResponseSchema, {
      ...graph(),
      embeddingSpaceId: 'space1',
      edges: [{
        kind: 'semantic_neighbor',
        id: 'similar1',
        endpoints: ['p1', 'p2'],
        embeddingSpaceId: 'space1',
        neighborPolicyId: 'policy1',
        cosine: 90,
        rankFromFirst: 1,
        rankFromSecond: 1,
        mutual: true,
      }],
    })).toThrow(HistoricalContractError);
  });

  it('rejects unknown search inputs rather than silently accepting caller scope', () => {
    expect(() => parseHistorical(HistoricalSearchRequestSchema, {
      query: 'John', allowedSources: ['private'],
    })).toThrow(HistoricalContractError);
  });

  it('does not expose source data in schema errors', () => {
    try {
      parseHistorical(HistoricalGraphResponseSchema, { secret: 'do-not-echo' }, 'graph');
      expect.fail('expected invalid payload');
    } catch (error) {
      expect(error).toBeInstanceOf(HistoricalContractError);
      expect(String(error)).not.toContain('do-not-echo');
    }
  });
});

describe('shared operation integrity', () => {
  function semanticGraph(): HistoricalGraphResponse {
    const data = graph();
    data.embeddingSpaceId = 'space1';
    const first = data.nodes[0];
    if (first.kind !== 'passage') throw new Error('invalid test fixture');
    data.nodes.push({ ...first, id: 'p2' });
    data.edges = [{
      kind: 'semantic_neighbor',
      id: 'similar1',
      endpoints: ['p1', 'p2'],
      embeddingSpaceId: 'space1',
      neighborPolicyId: 'policy1',
      cosine: 0.8,
      rankFromFirst: 1,
      rankFromSecond: 1,
      mutual: true,
    }];
    return data;
  }

  it('accepts a valid native TypeBox union and preserves uncalibrated cosine', () => {
    const data = semanticGraph();
    expect(parseHistoricalOperation('historical_graph_expand', data)).toEqual(data);
  });

  it.each([
    { label: 'complete page', page, valid: true },
    { label: 'complete stored neighborhood', page: { nextCursor: null, truncated: false, reasons: ['neighbor_policy'] }, valid: true },
    { label: 'limited semantic page', page: { nextCursor: 'next', truncated: true, reasons: ['edge_limit', 'neighbor_policy'] }, valid: true },
    { label: 'policy alone marked truncated', page: { nextCursor: null, truncated: true, reasons: ['neighbor_policy'] }, valid: false },
    { label: 'cursor on complete page', page: { nextCursor: 'next', truncated: false, reasons: ['neighbor_policy'] }, valid: false },
    { label: 'limit marked complete', page: { nextCursor: null, truncated: false, reasons: ['node_limit'] }, valid: false },
    { label: 'truncated without a limit', page: { nextCursor: null, truncated: true, reasons: [] }, valid: false },
  ])('distinguishes policy metadata from truncation: $label', ({ page: responsePage, valid }) => {
    const data = { ...semanticGraph(), page: responsePage };
    const decode = () => parseHistoricalOperation('historical_graph_expand', data);
    if (valid) expect(decode()).toEqual(data);
    else expect(decode).toThrow(HistoricalContractError);
  });

  it.each([HISTORICAL_LIMITS.maxSearchResults, HISTORICAL_LIMITS.maxSearchResults + 1])(
    'enforces the canonical output bound for %i unique search hits', count => {
      const node = graph().nodes[0];
      if (node.kind !== 'passage') throw new Error('invalid test fixture');
      const data: HistoricalSearchResponse = {
        apiVersion: 1, graphSnapshotId: 'snapshot1', resolutionStatus: 'resolved', resolvedSeedIds: [],
        hits: Array.from({ length: count }, (_, index) => {
          const id = `result-${index}`;
          return {
            node: { ...node, id }, method: 'lexical', rank: index + 1,
            entry: { graphSnapshotId: 'snapshot1', seedIds: [id], selectedPassageVersionId: id },
          };
        }), page,
      };
      const decode = () => parseHistoricalOperation('historical_search', data);
      const checkSchema = () => parseHistorical(HISTORICAL_TOOL_SCHEMAS.historical_search.output, data);
      if (count <= HISTORICAL_LIMITS.maxSearchResults) {
        expect(decode()).toEqual(data);
        expect(checkSchema()).toEqual(data);
      } else {
        expect(decode).toThrow(HistoricalContractError);
        expect(checkSchema).toThrow(HistoricalContractError);
      }
    },
  );

  it('binds distinct source evidence IDs to every recorded assertion without depending on order', () => {
    const data = relation();
    if (data.edge.kind !== 'recorded_reference') throw new Error('invalid test fixture');
    data.edge.assertionIds = ['a2', 'a1'];
    data.evidence.push(
      { ...data.evidence[0], id: 'source-evidence2', assertionId: 'a2' },
      { ...data.evidence[0], id: 'source-evidence3' },
    );
    expect(parseHistoricalOperation('historical_get_relation', data)).toEqual(data);
  });

  it.each(['unrelated', 'missing', 'duplicate', 'empty'])(
    'rejects %s recorded relation evidence', problem => {
      const data = relation();
      if (data.edge.kind !== 'recorded_reference') throw new Error('invalid test fixture');
      if (problem === 'unrelated') data.evidence[0].assertionId = 'other-assertion';
      if (problem === 'missing') data.edge.assertionIds.push('unrepresented-assertion');
      if (problem === 'duplicate') data.evidence.push({ ...data.evidence[0] });
      if (problem === 'empty') data.evidence = [];
      expect(() => parseHistoricalOperation('historical_get_relation', data)).toThrow(HistoricalContractError);
    },
  );

  it('rejects evidence without an explicit assertion association', () => {
    const data = relation();
    expect(() => parseHistoricalOperation('historical_get_relation', {
      ...data, evidence: [{ ...data.evidence[0], assertionId: undefined }],
    })).toThrow(HistoricalContractError);
  });

  it('accepts semantic build metadata but never editorial evidence on a semantic relation', () => {
    const data = {
      ...relation(), edge: semanticGraph().edges[0], evidence: [],
      semanticBuild: { buildId: 'build1' },
    };
    expect(parseHistoricalOperation('historical_get_relation', data)).toEqual(data);
    expect(() => parseHistoricalOperation('historical_get_relation', {
      ...data, evidence: relation().evidence,
    })).toThrow(HistoricalContractError);
  });

  it.each(['wrong-space', 'duplicate-edge', 'self-edge', 'anchor-edge', 'inconsistent-mutual', 'cosine-90'])(
    'rejects the same invalid semantic result in every consumer: %s', problem => {
      const data = semanticGraph();
      const edge = data.edges[0];
      if (edge.kind !== 'semantic_neighbor') throw new Error('invalid test fixture');
      if (problem === 'wrong-space') edge.embeddingSpaceId = 'unrelated-space';
      if (problem === 'duplicate-edge') data.edges.push({ ...edge });
      if (problem === 'self-edge') edge.endpoints = ['p1', 'p1'];
      if (problem === 'anchor-edge') edge.endpoints = ['p1', 'r1'];
      if (problem === 'inconsistent-mutual') edge.rankFromSecond = null;
      if (problem === 'cosine-90') edge.cosine = 90;
      expect(() => parseHistoricalOperation('historical_graph_expand', data)).toThrow(HistoricalContractError);
    },
  );

  it('rejects a selected search passage omitted from its roots', () => {
    const node = graph().nodes[0];
    if (node.kind !== 'passage') throw new Error('invalid test fixture');
    expect(() => parseHistoricalOperation('historical_search', {
      apiVersion: 1,
      graphSnapshotId: 'snapshot1',
      resolutionStatus: 'resolved',
      resolvedSeedIds: [],
      hits: [{
        node,
        method: 'lexical',
        rank: 1,
        entry: { graphSnapshotId: 'snapshot1', seedIds: ['unrelated'], selectedPassageVersionId: node.id },
      }],
      page,
    })).toThrow(HistoricalContractError);
  });

  it('binds a graph response to the actual request roots', () => {
    expect(() => parseHistoricalOperation('historical_graph_expand', graph(), {
      graphSnapshotId: 'snapshot1',
      seedIds: ['r1'],
    })).toThrow(HistoricalContractError);
  });

  it('rejects mixed-edition context rather than presenting it as adjacent source text', () => {
    expect(() => parseHistoricalOperation('historical_get_passage', {
      apiVersion: 1,
      graphSnapshotId: 'snapshot1',
      passage,
      contextBefore: [],
      contextAfter: [{ ...passage, id: 'p2', editionId: 'other-edition' }],
    }, { graphSnapshotId: 'snapshot1', passageVersionId: passage.id })).toThrow(HistoricalContractError);
  });

  it('preserves semantic validation errors without echoing source text', () => {
    const data = semanticGraph();
    const edge = data.edges[0];
    if (edge.kind !== 'semantic_neighbor') throw new Error('invalid test fixture');
    edge.embeddingSpaceId = 'do-not-echo-this-value';
    try {
      parseHistoricalOperation('historical_graph_expand', data);
      expect.fail('expected identity error');
    } catch (error) {
      expect(String(error)).not.toContain('do-not-echo-this-value');
    }
  });
});

describe('HistoricalClient', () => {
  it('uses structured output rather than parsing human summaries', async () => {
    const data = graph();
    const call = transport(data);
    await expect(new HistoricalClient(call).expandGraph({
      graphSnapshotId: 'snapshot1', seedIds: ['p1'],
    })).resolves.toEqual(data);
    expect(call).toHaveBeenCalledWith('historical_graph_expand', {
      graphSnapshotId: 'snapshot1', seedIds: ['p1'],
    });
  });

  it('does not fall back to prose when structured output is absent', async () => {
    const call: HistoricalToolCaller = async () => ({
      content: [{ type: 'text', text: JSON.stringify(graph()) }],
    });
    await expect(new HistoricalClient(call).expandGraph({
      graphSnapshotId: 'snapshot1', seedIds: ['p1'],
    })).rejects.toBeInstanceOf(HistoricalContractError);
  });

  it('rejects a tool error even if it contains valid-shaped data', async () => {
    await expect(new HistoricalClient(transport(graph(), true)).expandGraph({
      graphSnapshotId: 'snapshot1', seedIds: ['p1'],
    })).rejects.toBeInstanceOf(HistoricalToolError);
  });

  it('validates requests before executing the tool', async () => {
    const call = transport(graph());
    await expect(new HistoricalClient(call).expandGraph({
      graphSnapshotId: 'snapshot1', seedIds: [],
    })).rejects.toBeInstanceOf(HistoricalContractError);
    expect(call).not.toHaveBeenCalled();
  });

  it.each(['wrong-snapshot', 'wrong-root', 'duplicate-node', 'dangling-edge'])(
    'rejects inconsistent graph identities: %s', async problem => {
      const data = graph();
      if (problem === 'wrong-snapshot') data.graphSnapshotId = 'snapshot2';
      if (problem === 'wrong-root') data.seedIds = ['r1'];
      if (problem === 'duplicate-node') data.nodes.push(data.nodes[0]);
      if (problem === 'dangling-edge' && data.edges[0].kind === 'recorded_reference') {
        data.edges[0].to = 'missing';
      }
      await expect(new HistoricalClient(transport(data)).expandGraph({
        graphSnapshotId: 'snapshot1', seedIds: ['p1'],
      })).rejects.toBeInstanceOf(HistoricalContractError);
    },
  );

  it('requires the default catalog snapshot to be listed', async () => {
    await expect(new HistoricalClient(transport({
      apiVersion: 1, defaultSnapshotId: 'absent', snapshots: [],
    })).catalog()).rejects.toBeInstanceOf(HistoricalContractError);
  });

  it('allows an honestly empty catalog', async () => {
    await expect(new HistoricalClient(transport({
      apiVersion: 1, defaultSnapshotId: null, snapshots: [],
    })).catalog()).resolves.toEqual({ apiVersion: 1, defaultSnapshotId: null, snapshots: [] });
  });

  it('preserves the selected passage identity and bounded context', async () => {
    const data = { apiVersion: 1, graphSnapshotId: 'snapshot1', passage, contextBefore: [], contextAfter: [] };
    const call = transport(data);
    await expect(new HistoricalClient(call).getPassage({
      graphSnapshotId: 'snapshot1', passageVersionId: 'p1',
    })).resolves.toEqual(data);
    await expect(new HistoricalClient(call).getPassage({
      graphSnapshotId: 'snapshot1', passageVersionId: 'other',
    })).rejects.toBeInstanceOf(HistoricalContractError);
  });

  it('validates search evidence identities', async () => {
    const node = graph().nodes.find(item => item.kind === 'passage');
    if (!node || node.kind !== 'passage') throw new Error('invalid test fixture');
    const data: HistoricalSearchResponse = {
      apiVersion: 1,
      graphSnapshotId: 'snapshot1',
      resolutionStatus: 'resolved',
      resolvedSeedIds: [],
      hits: [{
        node,
        method: 'lexical',
        rank: 1,
        entry: { graphSnapshotId: 'snapshot1', seedIds: ['p1'], selectedPassageVersionId: 'p1' },
      }],
      page,
    };
    const client = new HistoricalClient(transport(data));
    await expect(client.search({ query: 'source' })).resolves.toEqual(data);
    data.hits[0].entry.selectedPassageVersionId = 'different';
    await expect(client.search({ query: 'source' })).rejects.toBeInstanceOf(HistoricalContractError);
  });

  it('validates relation identity', async () => {
    const data = relation();
    const client = new HistoricalClient(transport(data));
    await expect(client.getRelation({
      graphSnapshotId: 'snapshot1', relationId: 'e1',
    })).resolves.toEqual(data);
    await expect(client.getRelation({
      graphSnapshotId: 'snapshot1', relationId: 'missing',
    })).rejects.toBeInstanceOf(HistoricalContractError);
  });

  it('is exposed by NuBerea without a separate login or session', async () => {
    const client = new NuBerea({ accessToken: 'test-token' });
    const result: ToolResult = {
      content: [],
      structuredContent: { apiVersion: 1, defaultSnapshotId: null, snapshots: [] },
    };
    const call = vi.spyOn(client, 'tool').mockResolvedValue(result);
    expect(client.historical).toBe(client.historical);
    await client.historical.catalog();
    expect(call).toHaveBeenCalledWith('historical_catalog', {});
  });
});
