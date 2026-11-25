import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export class ApiError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number, readonly details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export function apiBaseUrl(base: string): string {
  const url = new URL(base);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) {
    throw new ApiError('API base must be credential-free HTTPS (HTTP is allowed only on loopback)');
  }
  return base.replace(/\/+$/, '');
}

export function parseApiPayload<T extends TSchema>(schema: T, value: unknown, label: string): Static<T> {
  if (!Value.Check(schema, value)) {
    const error = Value.Errors(schema, value).First();
    throw new ApiError(`Invalid ${label}: ${error?.path} ${error?.message}`, 'INVALID_API_PAYLOAD');
  }
  return value;
}

const ErrorBody = Type.Object({
  message: Type.Optional(Type.String()), code: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()), error_description: Type.Optional(Type.String()),
  details: Type.Optional(Type.Unknown()),
});

export async function responseFailure(response: Response, fallback: string): Promise<ApiError> {
  const text = await response.text();
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return new ApiError(`${fallback}${text ? `: ${text}` : ''}`, undefined, response.status);
  }
  if (!Value.Check(ErrorBody, value)) return new ApiError(fallback, undefined, response.status, value);
  return new ApiError(
    value.error_description ?? value.message ?? value.error ?? fallback,
    value.code ?? (value.error_description ? value.error : undefined),
    response.status,
    value.details ?? value,
  );
}

export interface ApiRequestOptions {
  signal?: AbortSignal;
  /** Public discovery, client registration and token exchange do not send a bearer token. */
  authenticated?: boolean;
  form?: URLSearchParams;
}

export class RestClient {
  readonly base: string;
  constructor(
    base: string,
    private readonly getToken: () => Promise<string>,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.base = base.replace(/\/+$/, '');
  }

  async request(method: string, path: string, body?: unknown, options: ApiRequestOptions = {}): Promise<unknown> {
    options.signal?.throwIfAborted();
    if (body !== undefined && options.form) throw new ApiError('Supply JSON or form data, not both', 'INVALID_API_PAYLOAD');
    const headers: Record<string, string> = {};
    if (options.authenticated !== false) {
      const token = await this.getToken();
      if (!token) throw new ApiError('An API bearer token is required', 'AUTH_REQUIRED');
      headers.Authorization = `Bearer ${token}`;
    }
    if (options.form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    else if (body !== undefined) headers['Content-Type'] = 'application/json';
    options.signal?.throwIfAborted();
    const response = await this.fetcher(this.base + path, {
      method, headers, redirect: 'error', signal: options.signal,
      ...(options.form ? { body: options.form.toString() }
        : body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await responseFailure(response, `${method} ${path} failed (HTTP ${response.status})`);
    if (response.status === 204 && method === 'DELETE') return undefined;
    const text = await response.text();
    if (!text) throw new ApiError(`Empty JSON response from ${method} ${path}`, 'INVALID_API_RESPONSE', response.status);
    try { return JSON.parse(text); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new ApiError(`Invalid JSON response from ${method} ${path}`, 'INVALID_API_RESPONSE', response.status);
    }
  }
}
