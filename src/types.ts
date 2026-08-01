/**
 * Shared types for the NuBerea SDK.
 */

// ============================================================================
// MCP Tool types
// ============================================================================

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

// ============================================================================
// Analytics / Query types
// ============================================================================

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionTimeMs: number;
  truncated: boolean;
  offset: number;
}

export type QueryFormat = 'json' | 'ndjson' | 'csv';

export interface TableInfo {
  table: string;
  columns: number;
  rowCount?: number;
}

export interface DatabaseInfo {
  name: string;
  description: string;
  tables: TableInfo[];
}

export interface ColumnInfo {
  column_name: string;
  column_type: string;
  null: string;
  key: string | null;
  default: string | null;
  extra: string | null;
}

export interface SchemaIntrospection {
  schema: string;
  description: string;
  tables: Array<{
    table: string;
    rowCount: number;
    columns: ColumnInfo[];
    sampleRows: Record<string, unknown>[];
  }>;
}

export interface StatsEntry {
  database: string;
  table: string;
  rowCount: number;
}

// ============================================================================
// Federated catalog (BYO-data) types
//
// These mirror the `/v1` catalog control plane served by the NuBerea MCP host.
// A connector always belongs to a tenant (the org unit owned by the signed-in
// user); queryable tools are registered against a connector. No customer
// secrets are ever stored.
// ============================================================================

export type TrustStatus = 'pending' | 'active' | 'error';
export type ConnectorStatus = 'pending' | 'active' | 'error';
export type ToolStatus = 'draft' | 'active' | 'disabled';

/** Supported connector kinds. */
export type ConnectorKind = 'glue_athena' | 'hf_dataset';

/** Secretless Hugging Face auth mode (private repos are not supported). */
export type HfAuthMode = 'public' | 'gated';

/** The org-level unit a federated grant belongs to. */
export interface Tenant {
  tenantId: string;
  displayName: string;
  tier?: string;
  ownerSubjects: string[];
  createdAt: string;
  updatedAt: string;
}

/** Tenant row enriched with status counts (for dashboards / `catalog tenants`). */
export interface TenantSummary {
  tenantId: string;
  displayName: string;
  createdAt: string;
  trustStatus: 'none' | TrustStatus;
  connectorCount: number;
  activeConnectorCount: number;
  toolCount: number;
  activeToolCount: number;
}

/** IAM artifacts the customer applies in their own AWS account (OIDC trust). */
export interface OidcIamTemplate {
  mode: 'oidc';
  oidcProvider: { url: string; clientIdList: string[]; thumbprintNote: string };
  trustPolicy: unknown;
  permissionPolicy: unknown;
  audience: string;
  subject: string;
}

export interface TrustResult {
  tenantId: string;
  status: 'pending';
  audience: string;
  subject: string;
  oidcTemplate: OidcIamTemplate;
}

export interface VerifyResult {
  status: TrustStatus;
  reason?: string;
  assumedRoleArn?: string;
}

/** NuBerea-side allowlist of what a Glue/Athena connector may read. */
export interface ConnectorScope {
  databases: string[];
  tables?: string[];
}

export interface GlueAthenaConnector {
  tenantId: string;
  connectorId: string;
  kind: 'glue_athena';
  region: string;
  athenaWorkgroup: string;
  scope: ConnectorScope;
  status: ConnectorStatus;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
  lastError?: string;
}

export interface HfDatasetConnector {
  tenantId: string;
  connectorId: string;
  kind: 'hf_dataset';
  repo: string;
  revision?: string;
  files: string[];
  tableName: string;
  auth: HfAuthMode;
  status: ConnectorStatus;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
  lastError?: string;
}

/**
 * A tenant's Hugging Face account — the identity gated connectors mint their
 * short-lived read tokens against. Held once per tenant, so renaming an HF
 * account is a single change rather than one per connector.
 */
export interface HfIdentity {
  tenantId: string;
  /** The HF username used as the token-exchange resource. */
  username: string;
  /** Immutable HF account id, recorded at verification when available. */
  hfUserId?: string;
  status: TrustStatus;
  lastVerifiedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HfIdentityVerifyResult {
  status: TrustStatus;
  username?: string;
  reason?: string;
}

/**
 * The exact values to register under Hugging Face's Authentication settings →
 * CI/CD Access. Available before an identity exists — it is what you need in
 * order to create one. Note the issuer is NuBerea, not huggingface.co, which is
 * the audience.
 */
export interface HfSetup {
  issuer: string;
  audience: string;
  subject: string;
}

/** A tenant's AWS trust binding. Holds no secret — role ARN and audience only. */
export interface AwsTrust {
  tenantId: string;
  provider: 'aws';
  roleArn: string;
  audience?: string;
  status: TrustStatus;
  lastAssumedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Fields of an existing HF connector that can be changed. `repo` and
 * `tableName` are absent on purpose: registered tools select FROM the table
 * name and were validated against that dataset's columns.
 */
export interface HfConnectorUpdate {
  auth?: HfAuthMode;
  revision?: string;
  files?: string[];
}

export type CatalogConnector = GlueAthenaConnector | HfDatasetConnector;

/** Parameters to create a Glue + Athena connector. */
export interface GlueConnectorInput {
  region: string;
  athenaWorkgroup: string;
  scope?: ConnectorScope;
}

/** Parameters to create a Hugging Face dataset connector. */
export interface HfConnectorInput {
  repo: string;
  tableName: string;
  files?: string[];
  auth?: HfAuthMode;
  revision?: string;
  /**
   * HF username for `gated` datasets. Convenience only: it seeds the tenant's
   * HF identity when none is set yet, and is **ignored** once one exists. To
   * change the account, use `setHfIdentity`.
   */
  hfResource?: string;
}

export interface ScopedTable {
  database: string;
  table: string;
  columns: Array<{ name: string; type: string }>;
}

export interface ValidateResult {
  status: TrustStatus;
  reason?: string;
  /** glue_athena */
  tables?: ScopedTable[];
  /** hf_dataset */
  columns?: string[];
  sample?: Array<Record<string, unknown>>;
}

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string; enum?: unknown[] }>;
  required?: string[];
}

export interface ParamBinding {
  sqlParam: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'date';
  default?: unknown;
  max?: number;
}

export interface ToolRegistrationInput {
  name: string;
  connectorId: string;
  description: string;
  inputSchema: ToolInputSchema;
  sqlTemplate: string;
  paramBindings: Record<string, ParamBinding>;
  rowLimit: number;
}

export interface CatalogTool extends ToolRegistrationInput {
  tenantId: string;
  toolId: string;
  status: ToolStatus;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SuggestedToolDraft extends ToolRegistrationInput {
  rationale: string;
}

export interface SuggestToolsResult {
  connectorId: string;
  suggestions: SuggestedToolDraft[];
  generatedAt: string;
}
