/**
 * NuBerea Catalog client — the BYO-data control plane.
 *
 * Wraps the `/v1` admin API served by the NuBerea MCP host: tenants, AWS OIDC
 * trust, connectors (Hugging Face datasets or AWS Glue + Athena), and the
 * parameterized SQL tools registered against them.
 *
 * Authentication reuses the SDK's OAuth token (the same bearer the MCP client
 * uses) via the injected `getToken` provider, so callers never handle a token
 * directly. No customer secrets are ever stored by NuBerea.
 *
 * @example
 * ```ts
 * const client = new NuBerea();
 * await client.login();
 *
 * const tenant = await client.catalog.createTenant('My Org');
 * const connector = await client.catalog.createHfConnector(tenant.tenantId, {
 *   repo: 'owner/name', tableName: 'orders', files: ['default/train/*.parquet'],
 * });
 * const result = await client.catalog.validateConnector(tenant.tenantId, connector.connectorId);
 * console.log(result.status, result.columns);
 * ```
 */

import type {
  CatalogConnector,
  CatalogTool,
  GlueAthenaConnector,
  GlueConnectorInput,
  HfConnectorInput,
  HfDatasetConnector,
  SuggestToolsResult,
  Tenant,
  TenantSummary,
  ToolRegistrationInput,
  ToolStatus,
  TrustResult,
  ValidateResult,
  VerifyResult,
} from './types.js';

export interface CatalogClientConfig {
  /** Base URL of the NuBerea MCP host (control plane is served under `/v1`). */
  baseUrl: string;
  /** Async provider for a valid bearer token (handles refresh upstream). */
  getToken: () => Promise<string>;
}

const enc = encodeURIComponent;

export class CatalogClient {
  constructor(private readonly config: CatalogClientConfig) {}

  // --------------------------------------------------------------- transport
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.config.getToken();
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!res.ok) {
      const msg =
        data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
          ? (data as { error: string }).error
          : `${method} ${path} failed (HTTP ${res.status})`;
      throw new Error(msg);
    }
    return data as T;
  }

  // ----------------------------------------------------------------- tenants
  /** Create a tenant (the org unit that owns connectors and tools). */
  createTenant(displayName: string, tier?: string): Promise<Tenant> {
    return this.request<Tenant>('POST', '/v1/tenants', { displayName, ...(tier ? { tier } : {}) });
  }

  /** List the tenants the authenticated user owns, with status counts. */
  async listTenants(): Promise<TenantSummary[]> {
    const { tenants } = await this.request<{ tenants: TenantSummary[] }>('GET', '/v1/tenants');
    return tenants;
  }

  getTenant(tenantId: string): Promise<Tenant> {
    return this.request<Tenant>('GET', `/v1/tenants/${enc(tenantId)}`);
  }

  renameTenant(tenantId: string, displayName: string): Promise<Tenant> {
    return this.request<Tenant>('PATCH', `/v1/tenants/${enc(tenantId)}`, { displayName });
  }

  /** Delete a tenant and cascade-delete its trust, connectors, and tools. */
  deleteTenant(tenantId: string): Promise<void> {
    return this.request<void>('DELETE', `/v1/tenants/${enc(tenantId)}`);
  }

  // ------------------------------------------------------------- AWS trust
  /** Begin an AWS OIDC trust; returns the IAM artifacts to apply in the customer account. */
  createAwsTrust(tenantId: string): Promise<TrustResult> {
    return this.request<TrustResult>('POST', `/v1/tenants/${enc(tenantId)}/trust/aws`, {});
  }

  /** Record the customer IAM role ARN created from the trust template. */
  setTrustRoleArn(tenantId: string, roleArn: string): Promise<{ status: string }> {
    return this.request('POST', `/v1/tenants/${enc(tenantId)}/trust/aws/role`, { roleArn });
  }

  /** Verify the trust by attempting the role assumption. */
  verifyAwsTrust(tenantId: string): Promise<VerifyResult> {
    return this.request<VerifyResult>('POST', `/v1/tenants/${enc(tenantId)}/trust/aws/verify`, {});
  }

  // -------------------------------------------------------------- connectors
  /** Create an AWS Glue + Athena connector (requires an active trust). */
  createGlueConnector(tenantId: string, params: GlueConnectorInput): Promise<GlueAthenaConnector> {
    return this.request<GlueAthenaConnector>('POST', `/v1/tenants/${enc(tenantId)}/connectors`, {
      region: params.region,
      athenaWorkgroup: params.athenaWorkgroup,
      ...(params.scope ? { scope: params.scope } : {}),
    });
  }

  /** Create a Hugging Face dataset connector (no trust required). */
  createHfConnector(tenantId: string, params: HfConnectorInput): Promise<HfDatasetConnector> {
    return this.request<HfDatasetConnector>('POST', `/v1/tenants/${enc(tenantId)}/connectors`, {
      kind: 'hf_dataset',
      repo: params.repo,
      tableName: params.tableName,
      files: params.files ?? [],
      auth: params.auth ?? 'public',
      ...(params.revision ? { revision: params.revision } : {}),
      ...(params.hfResource ? { hfResource: params.hfResource } : {}),
    });
  }

  async listConnectors(tenantId: string): Promise<CatalogConnector[]> {
    const { connectors } = await this.request<{ connectors: CatalogConnector[] }>(
      'GET',
      `/v1/tenants/${enc(tenantId)}/connectors`,
    );
    return connectors;
  }

  /** Dry-run connectivity from raw params without persisting a connector. */
  testConnector(
    tenantId: string,
    params: ({ kind: 'hf_dataset' } & HfConnectorInput) | ({ kind?: 'glue_athena' } & GlueConnectorInput),
  ): Promise<ValidateResult> {
    return this.request<ValidateResult>('POST', `/v1/tenants/${enc(tenantId)}/connectors/test`, params);
  }

  /** Validate (and activate) a persisted connector. */
  validateConnector(tenantId: string, connectorId: string): Promise<ValidateResult> {
    return this.request<ValidateResult>(
      'POST',
      `/v1/tenants/${enc(tenantId)}/connectors/${enc(connectorId)}/validate`,
      {},
    );
  }

  /** Ask NuBerea to draft parameterized tools from the connector schema. */
  suggestTools(
    tenantId: string,
    connectorId: string,
    opts?: { maxSuggestions?: number; prompt?: string },
  ): Promise<SuggestToolsResult> {
    return this.request<SuggestToolsResult>(
      'POST',
      `/v1/tenants/${enc(tenantId)}/connectors/${enc(connectorId)}/suggest-tools`,
      {
        ...(opts?.maxSuggestions !== undefined ? { maxSuggestions: opts.maxSuggestions } : {}),
        ...(opts?.prompt ? { prompt: opts.prompt } : {}),
      },
    );
  }

  /** Delete a connector. Rejected while any tool is still bound to it. */
  deleteConnector(tenantId: string, connectorId: string): Promise<void> {
    return this.request<void>('DELETE', `/v1/tenants/${enc(tenantId)}/connectors/${enc(connectorId)}`);
  }

  // ------------------------------------------------------------------- tools
  /** Register a parameterized, SELECT-only SQL tool against a connector. */
  registerTool(tenantId: string, input: ToolRegistrationInput): Promise<CatalogTool> {
    return this.request<CatalogTool>('POST', `/v1/tenants/${enc(tenantId)}/tools`, input);
  }

  async listTools(tenantId: string): Promise<CatalogTool[]> {
    const { tools } = await this.request<{ tools: CatalogTool[] }>('GET', `/v1/tenants/${enc(tenantId)}/tools`);
    return tools;
  }

  setToolStatus(tenantId: string, name: string, enabled: boolean): Promise<{ name: string; status: ToolStatus }> {
    return this.request('POST', `/v1/tenants/${enc(tenantId)}/tools/${enc(name)}/${enabled ? 'enable' : 'disable'}`, {});
  }

  deleteTool(tenantId: string, name: string): Promise<void> {
    return this.request<void>('DELETE', `/v1/tenants/${enc(tenantId)}/tools/${enc(name)}`);
  }
}
