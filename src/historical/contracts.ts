import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const HISTORICAL_API_VERSION = 1;
export const HISTORICAL_COLLECTION_ID = 'historical_sources';
export const HISTORICAL_LIMITS = {
  seeds: 8,
  defaultNodes: 120,
  maxNodes: 200,
  defaultEdges: 240,
  maxEdges: 400,
  responseBytes: 256 * 1024,
  defaultSearchResults: 20,
  maxSearchResults: 50,
  contextPassages: 3,
} as const;

const Id = Type.String({ minLength: 1, maxLength: 256 });
const Text = Type.String({ maxLength: 200_000 });
const NullableId = Type.Union([Id, Type.Null()]);
const NullableString = Type.Union([Type.String(), Type.Null()]);
const Ids = (maxItems: number) => Type.Array(Id, { maxItems, uniqueItems: true });
const ApiVersion = Type.Literal(HISTORICAL_API_VERSION);
const RequestOptions = { additionalProperties: false } as const;

export const HistoricalSourceSchema = Type.Object({
  corpusId: Id,
  sourceReleaseId: Id,
  label: Type.String(),
  language: Type.String(),
  attribution: Type.String(),
  licenseUri: NullableString,
  sourceUri: NullableString,
  coverage: Type.Union([
    Type.Literal('complete'),
    Type.Literal('partial'),
    Type.Literal('unknown'),
  ]),
});
export type HistoricalSource = Static<typeof HistoricalSourceSchema>;

export const ReferenceLocatorSchema = Type.Object({
  workId: Id,
  start: Type.String({ minLength: 1, maxLength: 256 }),
  end: NullableString,
});

export const HistoricalPassageNodeSchema = Type.Object({
  kind: Type.Literal('passage'),
  id: Id,
  corpusId: Id,
  sourceReleaseId: Id,
  workId: Id,
  editionId: Id,
  locatorLabel: Type.String(),
  language: Type.String(),
  preview: Type.String({ maxLength: 2048 }),
  previewTruncated: Type.Boolean(),
});
export type HistoricalPassageNode = Static<typeof HistoricalPassageNodeSchema>;

export const HistoricalReferenceNodeSchema = Type.Object({
  kind: Type.Literal('reference_anchor'),
  id: Id,
  referenceSchemeId: Id,
  referenceLabel: Type.String(),
  locator: ReferenceLocatorSchema,
});
export type HistoricalReferenceNode = Static<typeof HistoricalReferenceNodeSchema>;

export const HistoricalNodeSchema = Type.Union([
  HistoricalPassageNodeSchema,
  HistoricalReferenceNodeSchema,
]);
export type HistoricalNode = Static<typeof HistoricalNodeSchema>;

export const HistoricalPredicateSchema = Type.Union([
  Type.Literal('editorial_reference'),
  Type.Literal('editorial_quotation'),
  Type.Literal('reference_realization'),
  Type.Literal('recorded_parallel'),
]);

export const RecordedReferenceEdgeSchema = Type.Object({
  kind: Type.Literal('recorded_reference'),
  id: Id,
  from: Id,
  to: Id,
  predicate: HistoricalPredicateSchema,
  assertionIds: Type.Array(Id, { minItems: 1, uniqueItems: true }),
});
export type RecordedReferenceEdge = Static<typeof RecordedReferenceEdgeSchema>;

export const SemanticNeighborEdgeSchema = Type.Object({
  kind: Type.Literal('semantic_neighbor'),
  id: Id,
  endpoints: Type.Tuple([Id, Id]),
  embeddingSpaceId: Id,
  neighborPolicyId: Id,
  cosine: Type.Number({ minimum: -1, maximum: 1 }),
  rankFromFirst: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  rankFromSecond: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  mutual: Type.Boolean(),
});
export type SemanticNeighborEdge = Static<typeof SemanticNeighborEdgeSchema>;

export const HistoricalEdgeSchema = Type.Union([
  RecordedReferenceEdgeSchema,
  SemanticNeighborEdgeSchema,
]);
export type HistoricalEdge = Static<typeof HistoricalEdgeSchema>;

export const HistoricalPageSchema = Type.Object({
  nextCursor: NullableString,
  truncated: Type.Boolean(),
  reasons: Type.Array(Type.Union([
    Type.Literal('node_limit'),
    Type.Literal('edge_limit'),
    Type.Literal('byte_limit'),
    Type.Literal('neighbor_policy'),
  ]), { uniqueItems: true }),
});
export type HistoricalPage = Static<typeof HistoricalPageSchema>;

export const HistoricalNetworkEntrySchema = Type.Object({
  graphSnapshotId: Id,
  seedIds: Type.Array(Id, { minItems: 1, maxItems: HISTORICAL_LIMITS.seeds, uniqueItems: true }),
  selectedPassageVersionId: NullableId,
});
export type HistoricalNetworkEntry = Static<typeof HistoricalNetworkEntrySchema>;

export const HistoricalEvidenceEntrySchema = Type.Intersect([
  HistoricalNetworkEntrySchema,
  Type.Object({
    collectionId: Type.Literal(HISTORICAL_COLLECTION_ID),
    toolCallId: Id,
  }),
]);
export type HistoricalEvidenceEntry = Static<typeof HistoricalEvidenceEntrySchema>;

export const HistoricalFacsimileSchema = Type.Object({
  canvasUri: NullableString,
  imageUri: Type.String(),
  imageWidth: Type.Integer({ minimum: 1 }),
  imageHeight: Type.Integer({ minimum: 1 }),
  region: Type.Object({
    x: Type.Number({ minimum: 0 }),
    y: Type.Number({ minimum: 0 }),
    width: Type.Number({ exclusiveMinimum: 0 }),
    height: Type.Number({ exclusiveMinimum: 0 }),
  }),
});

export const HistoricalPassageSchema = Type.Object({
  id: Id,
  corpusId: Id,
  sourceReleaseId: Id,
  workId: Id,
  editionId: Id,
  locatorLabel: Type.String(),
  language: Type.String(),
  text: Text,
  textLayer: Id,
  sourceUri: NullableString,
  attribution: Type.String(),
  licenseUri: NullableString,
  previousPassageId: NullableId,
  nextPassageId: NullableId,
  facsimile: Type.Union([HistoricalFacsimileSchema, Type.Null()]),
  unresolvedReferences: Type.Array(Type.Object({
    target: Type.String(),
    reason: Type.String(),
  })),
});
export type HistoricalPassage = Static<typeof HistoricalPassageSchema>;

export const HistoricalAssertionEvidenceSchema = Type.Object({
  id: Id,
  corpusId: Id,
  sourceReleaseId: Id,
  sourceAnnotationId: Id,
  origin: Type.Union([
    Type.Literal('publisher_annotation'),
    Type.Literal('source_apparatus'),
    Type.Literal('human_review'),
    Type.Literal('reference_mapping'),
  ]),
  locatorLabel: Type.String(),
  sourceUri: NullableString,
  excerpt: NullableString,
  reviewStatus: Type.Union([
    Type.Literal('publisher_recorded'),
    Type.Literal('reviewed'),
    Type.Literal('unverified'),
  ]),
});
export type HistoricalAssertionEvidence = Static<typeof HistoricalAssertionEvidenceSchema>;

export const HistoricalRelationEvidenceSchema = Type.Object({
  ...HistoricalAssertionEvidenceSchema.properties,
  assertionId: Id,
});
export type HistoricalRelationEvidence = Static<typeof HistoricalRelationEvidenceSchema>;

export const HistoricalCatalogRequestSchema = Type.Object({}, RequestOptions);
export const HistoricalSnapshotDescriptorSchema = Type.Object({
  graphSnapshotId: Id,
  title: Type.String(),
  createdAt: Type.String(),
  sources: Type.Array(HistoricalSourceSchema),
  embeddingSpaceId: NullableId,
  capabilities: Type.Object({
    recordedReferences: Type.Boolean(),
    semanticNeighbors: Type.Boolean(),
    hybridSearch: Type.Boolean(),
  }),
});
export type HistoricalSnapshotDescriptor = Static<typeof HistoricalSnapshotDescriptorSchema>;

export const HistoricalCatalogResponseSchema = Type.Object({
  apiVersion: ApiVersion,
  defaultSnapshotId: NullableId,
  snapshots: Type.Array(HistoricalSnapshotDescriptorSchema),
});
export type HistoricalCatalogResponse = Static<typeof HistoricalCatalogResponseSchema>;

export const HistoricalSearchMethodSchema = Type.Union([
  Type.Literal('reference'),
  Type.Literal('lexical'),
  Type.Literal('hybrid'),
]);
export const HistoricalSearchRequestSchema = Type.Object({
  graphSnapshotId: Type.Optional(Id),
  method: Type.Optional(HistoricalSearchMethodSchema),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  referenceSchemeId: Type.Optional(Id),
  referenceWorkId: Type.Optional(Id),
  referenceStart: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  referenceEnd: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  editionId: Type.Optional(Id),
  corpusIds: Type.Optional(Ids(50)),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: HISTORICAL_LIMITS.maxSearchResults })),
  cursor: Type.Optional(NullableString),
}, RequestOptions);
export type HistoricalSearchRequest = Static<typeof HistoricalSearchRequestSchema>;

export const HistoricalSearchResponseSchema = Type.Object({
  apiVersion: ApiVersion,
  graphSnapshotId: Id,
  resolutionStatus: Type.Union([
    Type.Literal('resolved'),
    Type.Literal('unresolved'),
    Type.Literal('unsupported'),
  ]),
  resolvedSeedIds: Ids(HISTORICAL_LIMITS.seeds),
  hits: Type.Array(Type.Object({
    node: HistoricalPassageNodeSchema,
    method: HistoricalSearchMethodSchema,
    rank: Type.Integer({ minimum: 1 }),
    entry: HistoricalNetworkEntrySchema,
  }), { maxItems: HISTORICAL_LIMITS.maxSearchResults }),
  page: HistoricalPageSchema,
});
export type HistoricalSearchResponse = Static<typeof HistoricalSearchResponseSchema>;

export const HistoricalGraphRequestSchema = Type.Object({
  graphSnapshotId: Id,
  seedIds: Type.Array(Id, { minItems: 1, maxItems: HISTORICAL_LIMITS.seeds, uniqueItems: true }),
  neighborCorpusIds: Type.Optional(Ids(50)),
  edgeFamilies: Type.Optional(Type.Array(Type.Union([
    Type.Literal('recorded_reference'),
    Type.Literal('semantic_neighbor'),
  ]), { minItems: 1, uniqueItems: true })),
  embeddingSpaceId: Type.Optional(Id),
  limitNodes: Type.Optional(Type.Integer({ minimum: 1, maximum: HISTORICAL_LIMITS.maxNodes })),
  limitEdges: Type.Optional(Type.Integer({ minimum: 1, maximum: HISTORICAL_LIMITS.maxEdges })),
  cursor: Type.Optional(NullableString),
}, RequestOptions);
export type HistoricalGraphRequest = Static<typeof HistoricalGraphRequestSchema>;

export const HistoricalGraphResponseSchema = Type.Object({
  apiVersion: ApiVersion,
  graphSnapshotId: Id,
  seedIds: Type.Array(Id, { minItems: 1, maxItems: HISTORICAL_LIMITS.seeds, uniqueItems: true }),
  embeddingSpaceId: NullableId,
  nodes: Type.Array(HistoricalNodeSchema, { maxItems: HISTORICAL_LIMITS.maxNodes }),
  edges: Type.Array(HistoricalEdgeSchema, { maxItems: HISTORICAL_LIMITS.maxEdges }),
  page: HistoricalPageSchema,
});
export type HistoricalGraphResponse = Static<typeof HistoricalGraphResponseSchema>;

export const HistoricalPassageRequestSchema = Type.Object({
  graphSnapshotId: Id,
  passageVersionId: Id,
  contextBefore: Type.Optional(Type.Integer({ minimum: 0, maximum: HISTORICAL_LIMITS.contextPassages })),
  contextAfter: Type.Optional(Type.Integer({ minimum: 0, maximum: HISTORICAL_LIMITS.contextPassages })),
}, RequestOptions);
export type HistoricalPassageRequest = Static<typeof HistoricalPassageRequestSchema>;
export const HistoricalPassageResponseSchema = Type.Object({
  apiVersion: ApiVersion,
  graphSnapshotId: Id,
  passage: HistoricalPassageSchema,
  contextBefore: Type.Array(HistoricalPassageSchema, { maxItems: HISTORICAL_LIMITS.contextPassages }),
  contextAfter: Type.Array(HistoricalPassageSchema, { maxItems: HISTORICAL_LIMITS.contextPassages }),
});
export type HistoricalPassageResponse = Static<typeof HistoricalPassageResponseSchema>;

export const HistoricalRelationRequestSchema = Type.Object({
  graphSnapshotId: Id,
  relationId: Id,
}, RequestOptions);
export type HistoricalRelationRequest = Static<typeof HistoricalRelationRequestSchema>;
export const HistoricalRelationResponseSchema = Type.Object({
  apiVersion: ApiVersion,
  graphSnapshotId: Id,
  edge: HistoricalEdgeSchema,
  evidence: Type.Array(HistoricalRelationEvidenceSchema),
});
export type HistoricalRelationResponse = Static<typeof HistoricalRelationResponseSchema>;

export const HISTORICAL_TOOL_SCHEMAS = {
  historical_catalog: { input: HistoricalCatalogRequestSchema, output: HistoricalCatalogResponseSchema },
  historical_search: { input: HistoricalSearchRequestSchema, output: HistoricalSearchResponseSchema },
  historical_get_passage: { input: HistoricalPassageRequestSchema, output: HistoricalPassageResponseSchema },
  historical_graph_expand: { input: HistoricalGraphRequestSchema, output: HistoricalGraphResponseSchema },
  historical_get_relation: { input: HistoricalRelationRequestSchema, output: HistoricalRelationResponseSchema },
} as const;
export type HistoricalToolName = keyof typeof HISTORICAL_TOOL_SCHEMAS;
export type HistoricalOperationResponse<T extends HistoricalToolName> =
  Static<(typeof HISTORICAL_TOOL_SCHEMAS)[T]['output']>;

export class HistoricalContractError extends Error {
  readonly contract: string;

  constructor(contract: string) {
    super(`Invalid historical network payload: ${contract}`);
    this.name = 'HistoricalContractError';
    this.contract = contract;
  }
}

export function parseHistorical<T extends TSchema>(
  schema: T,
  value: unknown,
  contract = 'response',
): Static<T> {
  if (!Value.Check(schema, value)) throw new HistoricalContractError(contract);
  return value;
}

export function isHistoricalToolName(name: string): name is HistoricalToolName {
  return Object.hasOwn(HISTORICAL_TOOL_SCHEMAS, name);
}

function requireMatchingSnapshot(request: Record<string, unknown> | undefined, snapshot: string): void {
  if (request?.graphSnapshotId !== undefined && request.graphSnapshotId !== snapshot) {
    throw new HistoricalContractError('snapshot mismatch');
  }
}

export function parseHistoricalOperation<T extends HistoricalToolName>(
  name: T,
  payload: unknown,
  request?: Record<string, unknown>,
): HistoricalOperationResponse<T> {
  const schema: (typeof HISTORICAL_TOOL_SCHEMAS)[T]['output'] = HISTORICAL_TOOL_SCHEMAS[name].output;
  const result = parseHistorical(schema, payload, name);

  if ((name === 'historical_search' || name === 'historical_graph_expand') && 'page' in result) {
    const limited = result.page.reasons.some(reason => reason !== 'neighbor_policy');
    if (result.page.truncated !== limited || (!limited && result.page.nextCursor !== null)) {
      throw new HistoricalContractError('page continuation');
    }
  }

  if (name === 'historical_catalog' && Value.Check(HistoricalCatalogResponseSchema, result)) {
    const ids = new Set(result.snapshots.map(snapshot => snapshot.graphSnapshotId));
    if (ids.size !== result.snapshots.length ||
        (result.defaultSnapshotId !== null && !ids.has(result.defaultSnapshotId))) {
      throw new HistoricalContractError('catalog snapshot membership');
    }
  }

  if (name === 'historical_search' && Value.Check(HistoricalSearchResponseSchema, result)) {
    requireMatchingSnapshot(request, result.graphSnapshotId);
    const ids = new Set<string>();
    for (const hit of result.hits) {
      if (ids.has(hit.node.id) ||
          hit.entry.graphSnapshotId !== result.graphSnapshotId ||
          hit.entry.selectedPassageVersionId !== hit.node.id ||
          !hit.entry.seedIds.includes(hit.node.id)) {
        throw new HistoricalContractError('search evidence identity');
      }
      ids.add(hit.node.id);
    }
  }

  if (name === 'historical_graph_expand' && Value.Check(HistoricalGraphResponseSchema, result)) {
    requireMatchingSnapshot(request, result.graphSnapshotId);
    const nodes = new Map(result.nodes.map(node => [node.id, node]));
    const edgeIds = new Set(result.edges.map(edge => edge.id));
    if (nodes.size !== result.nodes.length || edgeIds.size !== result.edges.length ||
        result.seedIds.some(id => !nodes.has(id))) {
      throw new HistoricalContractError('graph identity');
    }
    if (request?.seedIds !== undefined) {
      const requested = parseHistorical(HistoricalGraphRequestSchema, request, 'graph request');
      if (result.seedIds.length !== requested.seedIds.length ||
          result.seedIds.some(id => !requested.seedIds.includes(id))) {
        throw new HistoricalContractError('graph root identity');
      }
    }
    for (const edge of result.edges) {
      const endpoints = edge.kind === 'recorded_reference' ? [edge.from, edge.to] : edge.endpoints;
      if (endpoints.some(id => !nodes.has(id))) {
        throw new HistoricalContractError('graph endpoints');
      }
      if (edge.kind === 'semantic_neighbor' &&
          (edge.embeddingSpaceId !== result.embeddingSpaceId ||
           endpoints[0] === endpoints[1] ||
           endpoints.some(id => nodes.get(id)?.kind !== 'passage') ||
           edge.mutual !== (edge.rankFromFirst !== null && edge.rankFromSecond !== null))) {
        throw new HistoricalContractError('semantic edge identity');
      }
    }
  }

  if (name === 'historical_get_passage' && Value.Check(HistoricalPassageResponseSchema, result)) {
    requireMatchingSnapshot(request, result.graphSnapshotId);
    if (request?.passageVersionId !== undefined && request.passageVersionId !== result.passage.id) {
      throw new HistoricalContractError('passage identity');
    }
    const ids = new Set([result.passage.id]);
    for (const context of [...result.contextBefore, ...result.contextAfter]) {
      if (ids.has(context.id) ||
          context.corpusId !== result.passage.corpusId ||
          context.sourceReleaseId !== result.passage.sourceReleaseId ||
          context.workId !== result.passage.workId ||
          context.editionId !== result.passage.editionId ||
          context.textLayer !== result.passage.textLayer) {
        throw new HistoricalContractError('passage context identity');
      }
      ids.add(context.id);
    }
  }

  if (name === 'historical_get_relation' && Value.Check(HistoricalRelationResponseSchema, result)) {
    requireMatchingSnapshot(request, result.graphSnapshotId);
    if (request?.relationId !== undefined && request.relationId !== result.edge.id) {
      throw new HistoricalContractError('relation identity');
    }
    if (result.edge.kind === 'recorded_reference') {
      const assertionIds = new Set(result.edge.assertionIds);
      const represented = new Set(result.evidence.map(evidence => evidence.assertionId));
      if (new Set(result.evidence.map(evidence => evidence.id)).size !== result.evidence.length ||
          represented.size !== assertionIds.size ||
          result.evidence.some(evidence => !assertionIds.has(evidence.assertionId))) {
        throw new HistoricalContractError('relation evidence identity');
      }
    } else if (result.evidence.length !== 0) {
      throw new HistoricalContractError('semantic relation evidence');
    }
  }

  return result;
}
