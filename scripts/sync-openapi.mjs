import { readFile, writeFile } from 'node:fs/promises';
import * as sdk from '../dist/index.js';

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/sync-openapi.mjs <web/src/data/openapi.json>');
const document = JSON.parse(await readFile(file, 'utf8'));
const apiServer = [{ url: 'https://api.nuberea.com/v1', description: 'Chat and agents' }];
const mcpServer = [{ url: 'https://mcp.nuberea.com', description: 'MCP, native Study and tenant catalog' }];
const authServer = [{ url: 'https://auth.nuberea.com', description: 'OAuth/OIDC' }];
const firebase = [{ firebaseAuth: [] }];
const oauth = [{ oauthAuth: ['mcp'] }];
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const string = { type: 'string' };
const number = { type: 'number' };
const array = (items = string) => ({ type: 'array', items });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const status = { type: 'string', enum: ['pending', 'active', 'error'] };

function schema(value) {
  if (Array.isArray(value)) return value.map(schema);
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['$id', '$schema'].includes(key)).map(([key, item]) => [key, schema(item)]));
  if (result.$ref && !result.$ref.startsWith('#/')) result.$ref = `#/components/schemas/${result.$ref}`;
  if ('const' in result) { result.enum = [result.const]; delete result.const; }
  if (result.anyOf) {
    const nullable = result.anyOf.some((item) => item.type === 'null');
    const choices = result.anyOf.filter((item) => item.type !== 'null');
    if (choices.every((item) => item.enum?.length === 1 && item.type === choices[0].type)) {
      delete result.anyOf;
      result.type = choices[0].type;
      result.enum = choices.flatMap((item) => item.enum);
      if (nullable) result.enum.push(null);
    } else if (nullable && choices.length === 1) {
      delete result.anyOf;
      Object.assign(result, choices[0]);
    } else result.anyOf = choices;
    if (nullable) {
      result.nullable = true;
      if (result.enum && !result.enum.includes(null)) result.enum.push(null);
    }
  }
  if (result.patternProperties) {
    const patterns = Object.values(result.patternProperties);
    if (patterns.length !== 1) throw new Error('Unsupported dictionary schema');
    result.additionalProperties = patterns[0];
    delete result.patternProperties;
  }
  return result;
}

const names = [
  ['ChatRequest', 'ChatRequestSchema'], ['ChatResponse', 'ChatResponseSchema'],
  ['ReasoningSkillUsage', 'ReasoningSkillUsageSchema'], ['ChatAttachment', 'ChatAttachmentSchema'],
  ['ScriptureReaderTarget', 'ScriptureReaderTargetSchema'], ['ToolCallRecord', 'ToolCallRecordSchema'],
  ['AgentPlanRequest', 'AgentPlanRequestSchema'], ['AgentRunRequest', 'AgentRunRequestSchema'],
  ['AgentPlanResponse', 'AgentPlanResponseSchema'], ['Plan', 'PlanSchema'], ['PlanStep', 'PlanStepSchema'],
  ['PlanInputRequest', 'PlanInputRequestSchema'], ['AgentNeedsInput', 'AgentNeedsInputSchema'],
  ['AgentStepUpdate', 'AgentStepUpdateSchema'], ['StudyReference', 'StudyReferenceSchema'],
  ['GreekLexiconRequest', 'GreekLexiconRequestSchema'], ['SemanticDomainRequest', 'SemanticDomainRequestSchema'],
  ['VerseStudy', 'VerseStudySchema'], ['GreekLexiconStudy', 'GreekLexiconStudySchema'],
  ['GreekSemanticDomainStudy', 'GreekSemanticDomainStudySchema'], ['StudyNode', 'StudyNodeSchema'],
  ['StudyWord', 'StudyWordSchema'], ['StudyToken', 'StudyTokenSchema'], ['UbsGreekMeaning', 'UbsGreekMeaningSchema'],
  ['LsjEntry', 'LsjEntrySchema'], ['AuthorizeRequest', 'AuthorizeRequestSchema'],
  ['OAuthTokenRequest', 'OAuthTokenRequestSchema'], ['OAuthTokenResponse', 'OAuthTokenResponseSchema'],
  ['OAuthRegistrationRequest', 'OAuthRegistrationRequestSchema'], ['OAuthRegistrationResponse', 'OAuthRegistrationResponseSchema'],
  ['OAuthUserInfo', 'OAuthUserInfoSchema'], ['OAuthMetadata', 'OAuthMetadataSchema'],
  ['ProtectedResourceMetadata', 'ProtectedResourceMetadataSchema'], ['Jwks', 'JwksSchema'],
];
const collections = document.components.schemas.ChatRequest.properties.enabledCollections.items.enum;
for (const [name, exportName] of names) document.components.schemas[name] = schema(sdk[exportName]);
const schemas = document.components.schemas;
for (const name of ['ChatRequest', 'AgentPlanRequest', 'AgentRunRequest']) {
  schemas[name].properties.enabledCollections.items.enum = collections;
  schemas[name].properties.conversationId.description =
    'Forbidden in this read-only SDK contract. Managed conversation mode can write Firebase revisions/history.';
  schemas[name].properties.attachments.description =
    'Ephemeral files: maximum five, 10 MiB total decoded, 4 MiB per PDF and 10 MiB per other file; JSON body maximum 15 MiB. No reusable Library IDs.';
}
schemas.ChatAttachment.description = 'Trimmed file name, supported media type and canonical padded base64 only. SDK enforces decoded byte limits; server validates readable text/PDF content without truncation.';
schemas.ChatAttachment['x-max-decoded-bytes'] = sdk.MAX_CHAT_ATTACHMENT_BYTES;
schemas.ChatAttachment['x-max-pdf-decoded-bytes'] = sdk.MAX_CHAT_PDF_BYTES;
schemas.ReasoningSkillUsage.description = 'Public metadata for applied advisory methods. Clients preserve IDs without a fixed skill catalog.';
schemas.ChatResponse.properties.reasoningSkills.items = ref('ReasoningSkillUsage');
schemas.PlanStep.description = 'inputPrompt is a nonblank question when needsUserInput is true, and exactly empty otherwise.';
schemas.VerseStudy.description = 'Read-only structured source data. Preserve token_id identity, source ordering, attribution and annotation status; dictionary candidates are not occurrence-level sense assignments.';
schemas.OAuthRegistrationResponse.description =
  'The current server returns registration metadata without durable client-registration persistence. The returned registration_client_uri is not an implemented client-management API.';
schemas.CatalogPlainError = object({ error: string });
schemas.OAuthError = object({ error: string, error_description: string }, ['error']);
const errorResponse = (description = 'Request failed.') => ({
  description, content: { 'application/json': { schema: { anyOf: [ref('ErrorResponse'), ref('CatalogPlainError'), ref('OAuthError')] } } },
});
const json = (name, description = 'Successful response.') => ({
  description, content: { 'application/json': { schema: ref(name) } },
});
const body = (name, type = 'application/json') => ({ required: true, content: { [type]: { schema: ref(name) } } });
const parameters = (path) => [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
  name: match[1], in: 'path', required: true, schema: string,
}));
function operation(method, path, { tag, id, summary, request, result, code = '200', security = oauth, servers = mcpServer, description = '' }) {
  document.paths[path] ??= {};
  document.paths[path][method] = {
    operationId: id, tags: [tag], summary, description, servers, security,
    ...(parameters(path).length ? { parameters: parameters(path) } : {}),
    ...(request ? { requestBody: body(request) } : {}),
    responses: {
      [code]: result ? json(result) : { description: 'Completed; no response body.' },
      '400': errorResponse('Invalid request.'), '401': errorResponse('Authentication required.'),
      '403': errorResponse('Insufficient access or paid entitlement.'),
      '404': errorResponse('Resource not found.'), '422': errorResponse('Validation/verification failed.'),
      '413': errorResponse('Request body or extracted evidence exceeds service limits.'),
      '415': errorResponse('Unsupported request body encoding or content type.'),
      '429': errorResponse('Rate limit exceeded; Retry-After may be provided.'),
      '500': errorResponse('Internal service error.'), '503': errorResponse('Required service unavailable.'),
    },
  };
  return document.paths[path][method];
}
function streamOperation(path, request, result, id, events, example) {
  const op = operation('post', path, {
    tag: path === '/chat' ? 'Chat' : 'Agents', id, summary: id,
    request, result, security: firebase, servers: apiServer,
    description: 'Read-only conversation-data mode: conversationId and unknown fields are rejected by the SDK. No managed Firebase history/revision writes. Provider response state, authentication and AWS rate-limit state are not covered by this restriction. Attachments are ephemeral and require Plus. Agent routes require Plus. SSE ends in done or error; never automatically retry an uncertain turn.',
  });
  op.responses['200'] = { description: 'JSON SSE activity followed by a complete done payload, or an error event.', content: {
    'text/event-stream': { schema: string, 'x-sse-events': events, example },
  } };
  op['x-firebase-conversation-writes'] = false;
  return op;
}
const commonEvents = {
  message: ref('ChatChunk'), thinking: ref('ChatThinking'),
  tool_call_start: ref('ToolCallRecord'), tool_call: ref('ToolCallRecord'), error: ref('ErrorResponse'),
};
const skill = { instructionId: 'reasoning.interpretation_formal', version: '1.0.0', title: 'Interpretation and formal structure' };
const chatExample = `event: reasoning_skills\ndata: ${JSON.stringify([skill])}\n\ndata: {"chunk":"The inference is invalid."}\n\nevent: done\ndata: ${JSON.stringify({
  message: 'The inference is invalid.', responseID: 'resp_example', isVerified: false, reasoningSkills: [skill],
})}\n\n`;
streamOperation('/chat', 'ChatRequest', 'ChatResponse', 'sendChatMessage', {
  ...commonEvents, reasoning_skills: array(ref('ReasoningSkillUsage')), done: ref('ChatResponse'),
}, chatExample);
const plan = { summary: 'Assess the supplied evidence.', assumptions: [], steps: [{
  id: 'step-1', title: 'Assess evidence', rationale: 'Check the supplied claims.', intendedTools: [],
  expectedSources: [], optional: false, needsUserInput: false, inputPrompt: '',
}] };
const planned = { plan, responseID: 'resp_plan', needsUserInput: false, inputRequests: [], sources: [] };
schemas.PlanningThinking = object({ message: string });
streamOperation('/agent/plan', 'AgentPlanRequest', 'AgentPlanResponse', 'planAgentTask', {
  thinking: ref('PlanningThinking'), plan: ref('AgentPlanResponse'), needs_input: ref('AgentNeedsInput'),
  done: ref('AgentPlanResponse'), error: ref('ErrorResponse'),
}, `event: thinking\ndata: {"message":"Planning..."}\n\nevent: plan\ndata: ${JSON.stringify(planned)}\n\nevent: done\ndata: ${JSON.stringify(planned)}\n\n`);
streamOperation('/agent/run', 'AgentRunRequest', 'ChatResponse', 'runAgentTask', {
  ...commonEvents, step: ref('AgentStepUpdate'), done: ref('ChatResponse'),
}, 'data: {"chunk":"Answer"}\n\nevent: done\ndata: {"message":"Answer","responseID":"resp_run","isVerified":false}\n\n');

for (const [path, request, result, id] of [
  ['/v1/study/verse', 'StudyReference', 'VerseStudy', 'studyVerse'],
  ['/v1/study/lexicon/greek', 'GreekLexiconRequest', 'GreekLexiconStudy', 'studyGreekLexicon'],
  ['/v1/study/semantic-domain/greek', 'SemanticDomainRequest', 'GreekSemanticDomainStudy', 'studyGreekSemanticDomain'],
]) {
  const op = operation('get', path, { tag: 'Study', id, summary: id, result, security: firebase,
    description: 'Read-only. Firebase ID token and paid access required; never substitute fixtures for a failed live request. Only the listed scalar query parameters are accepted. Greek lexicon requires exactly one of lemma or strong; Latin corpus is feature-gated.' });
  const source = schemas[request];
  const props = source.properties ?? Object.assign({}, ...source.anyOf.map((item) => item.properties));
  op.parameters = Object.entries(props).map(([name, item]) => ({
    name, in: 'query', required: source.required?.includes(name) ?? false, schema: item,
  }));
  op['x-query-schema'] = ref(request);
}

schemas.McpRequest = object({
  jsonrpc: { type: 'string', enum: ['2.0'] }, method: string,
  params: { type: 'object', additionalProperties: true },
  id: { anyOf: [string, { type: 'integer' }] },
}, ['jsonrpc', 'method']);
schemas.McpResponse = object({
  jsonrpc: { type: 'string', enum: ['2.0'] }, id: { anyOf: [{ ...string, nullable: true }, { type: 'integer', nullable: true }] },
  result: {}, error: object({ code: { type: 'integer' }, message: string, data: {} }, ['code', 'message']),
}, ['jsonrpc', 'id']);
schemas.McpResponse.oneOf = [{ required: ['result'], not: { required: ['error'] } },
  { required: ['error'], not: { required: ['result'] } }];
const mcp = operation('post', '/mcp', { tag: 'MCP', id: 'mcpRequest', summary: 'MCP JSON-RPC transport',
  request: 'McpRequest', result: 'McpResponse',
  description: 'OAuth-authenticated, sessionless MCP. Discover tools/resources and their schemas at runtime; this document deliberately contains no discovered tool catalog. Supports protocol requests and notifications. GET is unsupported (405); DELETE is a compatibility no-op. The SDK also exposes resource-template discovery.' });
mcp.responses['202'] = { description: 'Notification accepted; no response body.' };
mcp.responses['200'].content['text/event-stream'] = { schema: string };

schemas.Tenant = object({ tenantId: string, subjectId: string, displayName: string, tier: string,
  ownerSubjects: array(), createdAt: string, updatedAt: string }, ['tenantId', 'displayName', 'ownerSubjects', 'createdAt', 'updatedAt']);
schemas.TenantSummary = object({ tenantId: string, displayName: string, createdAt: string,
  trustStatus: { type: 'string', enum: ['none', 'pending', 'active', 'error'] },
  connectorCount: number, activeConnectorCount: number, toolCount: number, activeToolCount: number });
schemas.TenantList = object({ tenants: array(ref('TenantSummary')) });
schemas.TenantCreate = object({ displayName: string, tier: string }, ['displayName']);
schemas.TenantRename = object({ displayName: string });
schemas.AwsTrust = object({ tenantId: string, provider: { type: 'string', enum: ['aws'] }, roleArn: string,
  audience: string, status, lastAssumedAt: string, lastError: string, createdAt: string, updatedAt: string },
['tenantId', 'provider', 'roleArn', 'status', 'createdAt', 'updatedAt']);
schemas.AwsTrustCreate = object({ tenantId: string, status: { type: 'string', enum: ['pending'] },
  audience: string, subject: string, oidcTemplate: { type: 'object', additionalProperties: true } });
schemas.RoleArn = object({ roleArn: string });
schemas.StatusResult = object({ status });
schemas.VerifyResult = object({ status, reason: string, assumedRoleArn: string }, ['status']);
schemas.HfIdentity = object({ tenantId: string, username: string, hfUserId: string, status,
  lastVerifiedAt: string, lastError: string, createdAt: string, updatedAt: string },
['tenantId', 'username', 'status', 'createdAt', 'updatedAt']);
schemas.HfIdentityInput = object({ hfUsername: string });
schemas.HfSetup = object({ issuer: string, audience: string, subject: string });
schemas.HfVerifyResult = object({ status, username: string, reason: string }, ['status']);
schemas.HfRelation = object({ name: string, files: array() });
schemas.ConnectorScope = object({ databases: array(), tables: array() }, ['databases']);
schemas.GlueConnectorInput = object({ kind: { type: 'string', enum: ['glue_athena'] },
  region: string, athenaWorkgroup: string, scope: ref('ConnectorScope') }, ['region', 'athenaWorkgroup']);
schemas.HfConnectorInput = object({ kind: { type: 'string', enum: ['hf_dataset'] }, repo: string,
  tableName: string, files: array(), relations: array(ref('HfRelation')),
  auth: { type: 'string', enum: ['public', 'gated'] }, revision: string, hfResource: string },
['kind', 'repo', 'tableName', 'files']);
schemas.ConnectorInput = { anyOf: [ref('GlueConnectorInput'), ref('HfConnectorInput')] };
schemas.HfConnectorUpdate = object({ auth: { type: 'string', enum: ['public', 'gated'] },
  revision: string, files: array(), hfResource: string }, []);
schemas.Connector = object({ tenantId: string, connectorId: string, kind: { type: 'string', enum: ['glue_athena', 'hf_dataset'] },
  region: string, athenaWorkgroup: string, scope: ref('ConnectorScope'), repo: string, tableName: string, files: array(),
  relations: array(ref('HfRelation')), auth: string, revision: string, status, createdAt: string, updatedAt: string },
['tenantId', 'connectorId', 'kind', 'status', 'createdAt', 'updatedAt']);
schemas.ConnectorList = object({ connectors: array(ref('Connector')) });
schemas.ValidateResult = object({ status, reason: string, tables: array({ type: 'object' }),
  columns: array(), sample: array({ type: 'object', additionalProperties: true }) }, ['status']);
schemas.ToolRegistration = object({ name: string, connectorId: string, description: string,
  inputSchema: { type: 'object', additionalProperties: true }, sqlTemplate: string,
  paramBindings: { type: 'object', additionalProperties: true }, rowLimit: { type: 'integer' } });
schemas.CatalogTool = { allOf: [ref('ToolRegistration'), object({ tenantId: string, toolId: string,
  status: { type: 'string', enum: ['draft', 'active', 'disabled'] }, version: number,
  createdBy: string, createdAt: string, updatedAt: string })] };
schemas.ToolList = object({ tools: array(ref('CatalogTool')) });
schemas.SuggestToolsInput = object({ maxSuggestions: { type: 'integer' }, prompt: string }, []);
schemas.SuggestToolsResult = object({ connectorId: string, suggestions: array({
  allOf: [ref('ToolRegistration'), object({ rationale: string })],
}), generatedAt: string });
schemas.ToolStatusResult = object({ name: string, status: { type: 'string', enum: ['active', 'disabled'] } });
const t = '/v1/tenants/{tenantId}';
for (const [method, path, request, result, code, id] of [
  ['get', '/v1/tenants', null, 'TenantList', '200', 'listTenants'],
  ['post', '/v1/tenants', 'TenantCreate', 'Tenant', '201', 'createTenant'],
  ['get', t, null, 'Tenant', '200', 'getTenant'], ['patch', t, 'TenantRename', 'Tenant', '200', 'renameTenant'],
  ['delete', t, null, null, '204', 'deleteTenant'],
  ['get', t + '/trust/aws', null, 'AwsTrust', '200', 'getAwsTrust'],
  ['post', t + '/trust/aws', null, 'AwsTrustCreate', '201', 'createAwsTrust'],
  ['post', t + '/trust/aws/role', 'RoleArn', 'StatusResult', '200', 'setTrustRoleArn'],
  ['post', t + '/trust/aws/verify', null, 'VerifyResult', '200', 'verifyAwsTrust'],
  ['delete', t + '/trust/aws', null, null, '204', 'deleteAwsTrust'],
  ['get', t + '/hf-identity/setup', null, 'HfSetup', '200', 'getHfSetup'],
  ['get', t + '/hf-identity', null, 'HfIdentity', '200', 'getHfIdentity'],
  ['put', t + '/hf-identity', 'HfIdentityInput', 'HfIdentity', '200', 'setHfIdentity'],
  ['post', t + '/hf-identity/verify', null, 'HfVerifyResult', '200', 'verifyHfIdentity'],
  ['delete', t + '/hf-identity', null, null, '204', 'deleteHfIdentity'],
  ['get', t + '/connectors', null, 'ConnectorList', '200', 'listConnectors'],
  ['post', t + '/connectors', 'ConnectorInput', 'Connector', '201', 'createConnector'],
  ['post', t + '/connectors/test', 'ConnectorInput', 'ValidateResult', '200', 'testConnector'],
  ['patch', t + '/connectors/{connectorId}', 'HfConnectorUpdate', 'Connector', '200', 'updateHfConnector'],
  ['post', t + '/connectors/{connectorId}/validate', null, 'ValidateResult', '200', 'validateConnector'],
  ['post', t + '/connectors/{connectorId}/suggest-tools', 'SuggestToolsInput', 'SuggestToolsResult', '200', 'suggestTools'],
  ['delete', t + '/connectors/{connectorId}', null, null, '204', 'deleteConnector'],
  ['get', t + '/tools', null, 'ToolList', '200', 'listTenantTools'],
  ['post', t + '/tools', 'ToolRegistration', 'CatalogTool', '201', 'registerTenantTool'],
  ['post', t + '/tools/{name}/enable', null, 'ToolStatusResult', '200', 'enableTenantTool'],
  ['post', t + '/tools/{name}/disable', null, 'ToolStatusResult', '200', 'disableTenantTool'],
  ['delete', t + '/tools/{name}', null, null, '204', 'deleteTenantTool'],
]) {
  const op = operation(method, path, { tag: 'Catalog', id, summary: id, request, result, code,
    description: 'OAuth-authenticated tenant registry operation. Tenant administration is required; mutations require Plus. These management operations intentionally mutate AWS-backed tenant state, not Firebase conversation data. Tool SQL templates are read-only and tenant-scoped. No discovered tool names are enumerated here.' });
  if (['VerifyResult', 'ValidateResult', 'HfVerifyResult'].includes(result)) op.responses['422'] = json(result, 'Verification failed; status/reason describe the failure.');
}

for (const [path, result, id] of [
  ['/.well-known/openid-configuration', 'OAuthMetadata', 'openidMetadata'],
  ['/.well-known/oauth-authorization-server', 'OAuthMetadata', 'authorizationServerMetadata'],
  ['/.well-known/jwks.json', 'Jwks', 'publicSigningKeys'],
  ['/.well-known/oauth-protected-resource', 'ProtectedResourceMetadata', 'protectedResourceMetadata'],
  ['/.well-known/oauth-protected-resource/mcp', 'ProtectedResourceMetadata', 'mcpProtectedResourceMetadata'],
]) {
  const op = operation('get', path, { tag: 'Auth', id, summary: id, result, servers: authServer, security: [],
    description: 'Public standard discovery; no bearer token or Firebase conversation writes.' });
  if (path.endsWith('/mcp')) op.servers = [...authServer, ...mcpServer];
}
const authorize = operation('get', '/authorize', { tag: 'Auth', id: 'authorizeClient', summary: 'PKCE authorization',
  servers: authServer, security: [{ firebaseAuth: [] }, {}],
  description: 'S256 PKCE authorization. SDK calls use a Firebase bearer token and validate redirect target, state and issuer without following redirects. Unauthenticated browsers are redirected to sign-in. Authorization state is stored in AWS, not Firebase conversation data.' });
authorize.parameters = Object.entries(schemas.AuthorizeRequest.properties).map(([name, item]) => ({
  name, in: 'query', required: schemas.AuthorizeRequest.required.includes(name), schema: item,
}));
delete authorize.responses['200'];
authorize.responses['302'] = { description: 'Redirect with code, state and issuer, or browser sign-in redirect.',
  headers: { Location: { schema: string } } };
const token = operation('post', '/token', { tag: 'Auth', id: 'exchangeOAuthToken', summary: 'Exchange code or refresh token',
  request: 'OAuthTokenRequest', result: 'OAuthTokenResponse', servers: authServer, security: [],
  description: 'Public PKCE clients only. No Basic auth/client_secret. Refresh tokens rotate; do not automatically retry an uncertain exchange. SDK low-level token calls return credentials without changing cached login state.' });
token.requestBody = body('OAuthTokenRequest', 'application/x-www-form-urlencoded');
operation('post', '/register', { tag: 'Auth', id: 'registerOAuthClient', summary: 'Dynamic client-registration response',
  request: 'OAuthRegistrationRequest', result: 'OAuthRegistrationResponse', code: '201', servers: authServer, security: [],
  description: schemas.OAuthRegistrationResponse.description });
for (const method of ['get', 'post']) operation(method, '/userinfo', {
  tag: 'Auth', id: `${method}UserInfo`, summary: 'Read OAuth subject information', result: 'OAuthUserInfo',
  servers: authServer, security: [{ oauthAuth: ['openid'] }],
  description: 'Requires openid scope. Email claims require email scope. Reads Firebase identity metadata; does not write conversation data.',
});

document.info.description = 'Selected NuBerea SDK/REST contract: read-only chat and agent conversation modes, native Study, generic MCP transport, all tenant registry operations, and standard OAuth/OIDC. Managed Firebase conversation persistence, partner auth, health, billing and discovered tool catalogs are intentionally outside this document. Tenant management and OAuth token state retain their normal AWS/local mutations. Firebase ID tokens authenticate chat/agents/Study; MCP OAuth tokens authenticate MCP/catalog/userinfo. Use SDK browser login or a refreshing Firebase token provider.';
document.servers = apiServer;
document.components.securitySchemes.oauthAuth = {
  type: 'oauth2', flows: { authorizationCode: {
    authorizationUrl: 'https://auth.nuberea.com/authorize', tokenUrl: 'https://auth.nuberea.com/token',
    scopes: { mcp: 'MCP and tenant catalog access', openid: 'OAuth subject identity', email: 'Email identity claims' },
  } },
};
document.tags = ['Chat', 'Agents', 'Study', 'MCP', 'Catalog', 'Auth'].map((name) => ({ name }));
const signature = (value) => JSON.stringify(value, (key, item) =>
  key === 'description' || key.startsWith('x-') ? undefined : item);
const shared = new Map(Object.entries(schemas).map(([name, value]) => [signature(value), name]));
function references(value, root = false) {
  if (!value || typeof value !== 'object') return value;
  const name = !root && shared.get(signature(value));
  if (name) return ref(name);
  if (Array.isArray(value)) return value.map((item) => references(item));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, key === 'example' ? item : references(item),
  ]));
}
for (const [name, value] of Object.entries(schemas)) schemas[name] = references(value, true);
await writeFile(file, JSON.stringify(document, null, 2) + '\n');
console.log(`Updated ${Object.keys(document.paths).length} paths from SDK schemas; no discovered tool catalog.`);
