import { Type, type Static } from '@sinclair/typebox';
import { RestClient, ApiError, apiBaseUrl, parseApiPayload, responseFailure } from './http.js';

export const AuthorizeRequestSchema = Type.Object({
  response_type: Type.Literal('code'), client_id: Type.String({ minLength: 1 }),
  redirect_uri: Type.String({ minLength: 1 }), code_challenge: Type.String({ minLength: 43, maxLength: 128 }),
  code_challenge_method: Type.Literal('S256'), state: Type.String({ minLength: 1 }),
  resource: Type.String({ minLength: 1 }), scope: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type AuthorizeRequest = Static<typeof AuthorizeRequestSchema>;
export interface AuthorizationCode { code: string; state: string; issuer?: string }
const commonTokenFields = {
  client_id: Type.String({ minLength: 1 }), resource: Type.String({ minLength: 1 }),
  client_secret: Type.Optional(Type.Never()),
};
export const OAuthTokenRequestSchema = Type.Union([
  Type.Object({
    ...commonTokenFields, grant_type: Type.Literal('authorization_code'), code: Type.String({ minLength: 1 }),
    redirect_uri: Type.String({ minLength: 1 }), code_verifier: Type.String({ minLength: 43, maxLength: 128 }),
  }, { additionalProperties: false }),
  Type.Object({
    ...commonTokenFields, grant_type: Type.Literal('refresh_token'), refresh_token: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
]);
export type OAuthTokenRequest = Static<typeof OAuthTokenRequestSchema>;
export const OAuthTokenResponseSchema = Type.Object({
  access_token: Type.String(), token_type: Type.String(), expires_in: Type.Number(),
  refresh_token: Type.Optional(Type.String()), scope: Type.Optional(Type.String()),
  id_token: Type.Optional(Type.String()),
});
export type OAuthTokenResponse = Static<typeof OAuthTokenResponseSchema>;
export const OAuthRegistrationRequestSchema = Type.Object({
  redirect_uris: Type.Array(Type.String(), { minItems: 1 }),
  client_name: Type.Optional(Type.String()), client_uri: Type.Optional(Type.String()), logo_uri: Type.Optional(Type.String()),
  scope: Type.Optional(Type.String()), contacts: Type.Optional(Type.Array(Type.String())),
  grant_types: Type.Optional(Type.Array(Type.String())), response_types: Type.Optional(Type.Array(Type.String())),
  token_endpoint_auth_method: Type.Optional(Type.Literal('none')),
}, { additionalProperties: false });
export type OAuthRegistrationRequest = Static<typeof OAuthRegistrationRequestSchema>;
export const OAuthRegistrationResponseSchema = Type.Object({
  ...OAuthRegistrationRequestSchema.properties,
  client_id: Type.String(), client_id_issued_at: Type.Number(),
  grant_types: Type.Array(Type.String()), response_types: Type.Array(Type.String()),
  token_endpoint_auth_method: Type.Literal('none'),
  registration_client_uri: Type.String(), registration_access_token: Type.String(),
});
export type OAuthRegistrationResponse = Static<typeof OAuthRegistrationResponseSchema>;
export const OAuthUserInfoSchema = Type.Object({
  sub: Type.String(), email: Type.Optional(Type.String()), email_verified: Type.Optional(Type.Boolean()),
});
export type OAuthUserInfo = Static<typeof OAuthUserInfoSchema>;
export const OAuthMetadataSchema = Type.Object({
  issuer: Type.String(), authorization_endpoint: Type.String(), token_endpoint: Type.String(), jwks_uri: Type.String(),
  userinfo_endpoint: Type.Optional(Type.String()), registration_endpoint: Type.Optional(Type.String()),
  scopes_supported: Type.Optional(Type.Array(Type.String())),
  response_types_supported: Type.Optional(Type.Array(Type.String())),
  grant_types_supported: Type.Optional(Type.Array(Type.String())),
  code_challenge_methods_supported: Type.Optional(Type.Array(Type.String())),
  token_endpoint_auth_methods_supported: Type.Optional(Type.Array(Type.String())),
  claims_supported: Type.Optional(Type.Array(Type.String())),
});
export type OAuthMetadata = Static<typeof OAuthMetadataSchema>;
export const ProtectedResourceMetadataSchema = Type.Object({
  resource: Type.String(), authorization_servers: Type.Array(Type.String()),
  bearer_methods_supported: Type.Optional(Type.Array(Type.String())),
  scopes_supported: Type.Optional(Type.Array(Type.String())),
  resource_signing_alg_values_supported: Type.Optional(Type.Array(Type.String())),
  resource_documentation: Type.Optional(Type.String()),
});
export type ProtectedResourceMetadata = Static<typeof ProtectedResourceMetadataSchema>;
export const JwksSchema = Type.Object({
  keys: Type.Array(Type.Object({
    kty: Type.String(), kid: Type.Optional(Type.String()), alg: Type.Optional(Type.String()),
    use: Type.Optional(Type.String()), n: Type.Optional(Type.String()), e: Type.Optional(Type.String()),
  })),
});
export type Jwks = Static<typeof JwksSchema>;

export interface OAuthClientConfig {
  baseUrl: string;
  getAccessToken: () => Promise<string>;
  getFirebaseIdToken: () => Promise<string>;
}
export class OAuthClient {
  private readonly rest: RestClient;
  private readonly base: string;
  constructor(private readonly config: OAuthClientConfig, private readonly fetcher: typeof fetch = fetch) {
    this.base = apiBaseUrl(config.baseUrl);
    this.rest = new RestClient(this.base, config.getAccessToken, fetcher);
  }

  async authorize(request: AuthorizeRequest, signal?: AbortSignal): Promise<AuthorizationCode> {
    parseApiPayload(AuthorizeRequestSchema, request, 'authorization request');
    signal?.throwIfAborted();
    const token = await this.config.getFirebaseIdToken();
    if (!token) throw new ApiError('A Firebase ID token is required for authorization', 'AUTH_REQUIRED');
    signal?.throwIfAborted();
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(request)) if (value !== undefined) query.set(name, value);
    const response = await this.fetcher(`${this.base}/authorize?${query}`, {
      method: 'GET', redirect: 'manual', signal, headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status !== 302) throw await responseFailure(response, `Authorization failed (${response.status})`);
    const location = response.headers.get('location');
    if (!location) throw new ApiError('Authorization returned no redirect', 'INVALID_API_RESPONSE');
    const redirect = new URL(location, request.redirect_uri);
    const expected = new URL(request.redirect_uri);
    if (redirect.origin !== expected.origin || redirect.pathname !== expected.pathname) {
      throw new ApiError('Authorization returned an unexpected redirect URI', 'INVALID_API_RESPONSE');
    }
    const error = redirect.searchParams.get('error');
    if (error) throw new ApiError(redirect.searchParams.get('error_description') ?? error, error);
    const code = redirect.searchParams.get('code');
    const state = redirect.searchParams.get('state');
    const issuer = redirect.searchParams.get('iss');
    if (!code || state !== request.state || (issuer && issuer.replace(/\/+$/, '') !== this.base)) {
      throw new ApiError('Authorization response code, state or issuer is invalid', 'INVALID_API_RESPONSE');
    }
    return { code, state, ...(issuer ? { issuer } : {}) };
  }
  async token(request: OAuthTokenRequest, signal?: AbortSignal): Promise<OAuthTokenResponse> {
    parseApiPayload(OAuthTokenRequestSchema, request, 'token request');
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(request)) if (value !== undefined) form.set(key, value);
    return parseApiPayload(OAuthTokenResponseSchema, await this.rest.request('POST', '/token', undefined, {
      signal, authenticated: false, form,
    }), 'OAuth token response');
  }
  async register(request: OAuthRegistrationRequest, signal?: AbortSignal): Promise<OAuthRegistrationResponse> {
    parseApiPayload(OAuthRegistrationRequestSchema, request, 'client registration');
    for (const uri of request.redirect_uris) {
      const url = new URL(uri);
      if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
        || url.username || url.password || url.hash) {
        throw new ApiError('Client redirect URIs require HTTPS or HTTP loopback and no credentials/fragments', 'INVALID_API_PAYLOAD');
      }
    }
    if (request.grant_types && !request.grant_types.includes('authorization_code')) {
      throw new ApiError('Client registration grant_types must include authorization_code', 'INVALID_API_PAYLOAD');
    }
    if (request.response_types && !request.response_types.includes('code')) {
      throw new ApiError('Client registration response_types must include code', 'INVALID_API_PAYLOAD');
    }
    return parseApiPayload(OAuthRegistrationResponseSchema,
      await this.rest.request('POST', '/register', request, { signal, authenticated: false }), 'client registration response');
  }
  async userinfo(options: { method?: 'GET' | 'POST'; signal?: AbortSignal } = {}): Promise<OAuthUserInfo> {
    return parseApiPayload(OAuthUserInfoSchema,
      await this.rest.request(options.method ?? 'GET', '/userinfo', undefined, { signal: options.signal }), 'userinfo');
  }
  async metadata(kind: 'openid' | 'authorization-server' = 'authorization-server', signal?: AbortSignal): Promise<OAuthMetadata> {
    if (kind !== 'openid' && kind !== 'authorization-server') throw new ApiError('Invalid metadata kind', 'INVALID_API_PAYLOAD');
    const path = kind === 'openid' ? '/.well-known/openid-configuration' : '/.well-known/oauth-authorization-server';
    return parseApiPayload(OAuthMetadataSchema,
      await this.rest.request('GET', path, undefined, { signal, authenticated: false }), 'OAuth metadata');
  }
  async jwks(signal?: AbortSignal): Promise<Jwks> {
    return parseApiPayload(JwksSchema,
      await this.rest.request('GET', '/.well-known/jwks.json', undefined, { signal, authenticated: false }), 'JWKS');
  }
  async protectedResource(mcp = true, signal?: AbortSignal): Promise<ProtectedResourceMetadata> {
    if (typeof mcp !== 'boolean') throw new ApiError('Invalid protected-resource selector', 'INVALID_API_PAYLOAD');
    return parseApiPayload(ProtectedResourceMetadataSchema, await this.rest.request('GET',
      `/.well-known/oauth-protected-resource${mcp ? '/mcp' : ''}`, undefined, { signal, authenticated: false }),
    'protected-resource metadata');
  }
}
