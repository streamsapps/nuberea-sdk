/**
 * NuBerea SDK
 *
 * Client library for the NuBerea biblical data platform.
 * Supports both MCP (Model Context Protocol) and REST query interfaces.
 *
 * @example
 * ```ts
 * import { NuBerea } from '@nuberea/sdk';
 *
 * const client = new NuBerea();
 * await client.login();
 *
 * // Call any MCP tool
 * const result = await client.tool('bible_kjv_get_verse', {
 *   book: 'John', chapter: 1, verse: 1,
 * });
 *
 * // Run SQL analytics
 * const rows = await client.query(
 *   'SELECT * FROM hebrew.morphemes WHERE book_id = \'Gen\' AND chapter = 1 LIMIT 10'
 * );
 *
 * // List available tools
 * const tools = await client.tools();
 * ```
 */

export { NuBerea } from './client.js';
export type { NuBereaConfig, NuBereaTokens } from './client.js';
export { MCP_ENDPOINTS, NuBereaAuth, resolveMcpUrl, createPkce } from './auth.js';
export {
  ChatClient, ChatError, ChatRequestSchema, ChatResponseSchema, ReasoningSkillUsageSchema,
  ScriptureReaderTargetSchema, ToolCallRecordSchema, resolveChatBaseUrl,
  ChatAttachmentSchema, MAX_CHAT_ATTACHMENT_BYTES, MAX_CHAT_PDF_BYTES, MAX_CHAT_BODY_BYTES,
} from './chat.js';
export type {
  ChatRequest, ChatResponse, ChatOptions, ChatThinking, ReasoningSkillUsage, ToolCallRecord, ScriptureReaderTarget,
  ChatAttachment,
} from './chat.js';
export { AgentClient, AgentPlanRequestSchema, AgentRunRequestSchema, AgentPlanResponseSchema,
  PlanSchema, PlanStepSchema, PlanInputRequestSchema, AgentNeedsInputSchema, AgentStepUpdateSchema } from './agent.js';
export type { AgentPlan, AgentPlanRequest, AgentRunRequest, AgentPlanResponse,
  AgentNeedsInput, AgentStepUpdate, AgentPlanOptions, AgentRunOptions } from './agent.js';
export { StudyClient, StudyReferenceSchema, GreekLexiconRequestSchema, SemanticDomainRequestSchema,
  VerseStudySchema, GreekLexiconStudySchema, GreekSemanticDomainStudySchema, StudyNodeSchema,
  StudyWordSchema, StudyTokenSchema, UbsGreekMeaningSchema, LsjEntrySchema } from './study.js';
export type { StudyReference, VerseStudy, GreekLexiconRequest, GreekLexiconStudy,
  GreekSemanticDomainStudy, UbsGreekMeaning } from './study.js';
export { OAuthClient, AuthorizeRequestSchema, OAuthTokenRequestSchema, OAuthTokenResponseSchema,
  OAuthRegistrationRequestSchema, OAuthRegistrationResponseSchema, OAuthMetadataSchema,
  OAuthUserInfoSchema, ProtectedResourceMetadataSchema, JwksSchema } from './oauth.js';
export type { OAuthClientConfig, AuthorizeRequest, AuthorizationCode, OAuthTokenRequest,
  OAuthTokenResponse, OAuthRegistrationRequest, OAuthRegistrationResponse, OAuthMetadata,
  OAuthUserInfo, ProtectedResourceMetadata, Jwks } from './oauth.js';
export { ApiError } from './http.js';
export type { AuthConfig } from './auth.js';
export { CatalogClient } from './catalog.js';
export type { CatalogClientConfig } from './catalog.js';
export { McpClient, McpError } from './mcp.js';
export type {
  McpClientConfig,
  McpServerInfo,
  McpCapabilities,
  McpInitializeResult,
  McpResource,
  McpResourceContent,
  McpResourceTemplate,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
} from './mcp.js';
export type {
  ToolResult,
  ToolInfo,
  QueryResult,
  DatabaseInfo,
  TableInfo,
  ColumnInfo,
  SchemaIntrospection,
  StatsEntry,
  TrustStatus,
  ConnectorStatus,
  ToolStatus,
  ConnectorKind,
  HfAuthMode,
  Tenant,
  TenantSummary,
  OidcIamTemplate,
  TrustResult,
  VerifyResult,
  ConnectorScope,
  GlueAthenaConnector,
  HfDatasetConnector,
  HfIdentity,
  HfIdentityVerifyResult,
  HfSetup,
  AwsTrust,
  HfConnectorUpdate,
  HfRelation,
  CatalogConnector,
  GlueConnectorInput,
  HfConnectorInput,
  ScopedTable,
  ValidateResult,
  ToolInputSchema,
  ParamBinding,
  ToolRegistrationInput,
  CatalogTool,
  SuggestedToolDraft,
  SuggestToolsResult,
} from './types.js';
