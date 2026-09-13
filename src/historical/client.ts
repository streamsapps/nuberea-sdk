import type { TSchema, Static } from '@sinclair/typebox';
import type { ToolResult } from '../types.js';
import {
  HistoricalCatalogResponseSchema,
  HistoricalGraphRequestSchema,
  HistoricalGraphResponseSchema,
  HistoricalPassageRequestSchema,
  HistoricalPassageResponseSchema,
  HistoricalRelationRequestSchema,
  HistoricalRelationResponseSchema,
  HistoricalSearchRequestSchema,
  HistoricalSearchResponseSchema,
  parseHistorical,
  parseHistoricalOperation,
  type HistoricalCatalogResponse,
  type HistoricalGraphRequest,
  type HistoricalGraphResponse,
  type HistoricalPassageRequest,
  type HistoricalPassageResponse,
  type HistoricalRelationRequest,
  type HistoricalRelationResponse,
  type HistoricalSearchRequest,
  type HistoricalSearchResponse,
  type HistoricalToolName,
} from './contracts.js';

export type HistoricalToolCaller = (
  name: HistoricalToolName,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

export class HistoricalToolError extends Error {
  constructor(readonly toolName: HistoricalToolName) {
    super(`Historical tool failed: ${toolName}`);
    this.name = 'HistoricalToolError';
  }
}

export class HistoricalClient {
  constructor(private readonly callTool: HistoricalToolCaller) {}

  private async call<T extends TSchema>(
    name: HistoricalToolName,
    args: Record<string, unknown>,
    schema: T,
  ): Promise<Static<T>> {
    const result = await this.callTool(name, args);
    if (result.isError) throw new HistoricalToolError(name);
    return parseHistorical(schema, parseHistoricalOperation(name, result.structuredContent, args), name);
  }

  async catalog(): Promise<HistoricalCatalogResponse> {
    return this.call('historical_catalog', {}, HistoricalCatalogResponseSchema);
  }

  async search(request: HistoricalSearchRequest): Promise<HistoricalSearchResponse> {
    const input = parseHistorical(HistoricalSearchRequestSchema, request, 'search request');
    return this.call('historical_search', input, HistoricalSearchResponseSchema);
  }

  async getPassage(request: HistoricalPassageRequest): Promise<HistoricalPassageResponse> {
    const input = parseHistorical(HistoricalPassageRequestSchema, request, 'passage request');
    return this.call('historical_get_passage', input, HistoricalPassageResponseSchema);
  }

  async expandGraph(request: HistoricalGraphRequest): Promise<HistoricalGraphResponse> {
    const input = parseHistorical(HistoricalGraphRequestSchema, request, 'graph request');
    return this.call('historical_graph_expand', input, HistoricalGraphResponseSchema);
  }

  async getRelation(request: HistoricalRelationRequest): Promise<HistoricalRelationResponse> {
    const input = parseHistorical(HistoricalRelationRequestSchema, request, 'relation request');
    return this.call('historical_get_relation', input, HistoricalRelationResponseSchema);
  }
}
