interface ResearchReferenceBase {
  referenceId: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  importedAt: string;
}

export type ResearchReference = ResearchReferenceBase & (
  | {
      provider: 'google_drive';
      providerFileId: string;
      providerVersion?: string;
      providerModifiedAt?: string;
      providerUrl?: string;
    }
  | {
      provider: 'device';
      providerFileId?: never;
      providerVersion?: never;
      providerModifiedAt?: never;
      providerUrl?: never;
    }
);

export interface ResearchRunRequest {
  userMessage: string;
  gptModel: string;
  referenceIds?: string[];
  previous_response_id?: string | null;
  enabledCollections?: string[];
  workflowMode?: string | null;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface ResearchClientConfig {
  baseUrl: string;
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
}

type ErrorPayload = {
  message?: string;
  code?: string;
};

export class ResearchApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export class ResearchClient {
  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string>;
  private readonly fetcher: typeof fetch;

  constructor(config: ResearchClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.getToken = config.getToken;
    this.fetcher = config.fetch ?? fetch;
  }

  async importGoogleDriveReference(
    fileId: string,
    googleAccessToken: string,
  ): Promise<ResearchReference> {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) {
      throw new TypeError('fileId must be a Google Drive file identifier');
    }
    if (!googleAccessToken || /\s/.test(googleAccessToken)) {
      throw new TypeError('googleAccessToken is required');
    }
    const response = await this.request('/harness/references/google-drive', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Google-Drive-Token': googleAccessToken,
      },
      body: JSON.stringify({ fileId }),
    });
    return ((await response.json()) as { reference: ResearchReference }).reference;
  }

  async importDeviceReference(
    name: string,
    mediaType: string,
    content: Uint8Array,
  ): Promise<ResearchReference> {
    if (!name.trim()) throw new TypeError('name is required');
    if (!mediaType.trim()) throw new TypeError('mediaType is required');
    const response = await this.request('/harness/references/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(name),
        'X-File-Media-Type': mediaType,
      },
      body: Buffer.from(content),
    });
    return ((await response.json()) as { reference: ResearchReference }).reference;
  }

  async getReferenceDownloadUrl(referenceId: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(referenceId)) {
      throw new TypeError('referenceId must be a 64-character SHA-256 identifier');
    }
    const response = await this.request(
      `/harness/references/${encodeURIComponent(referenceId)}/download`,
    );
    return ((await response.json()) as { url: string }).url;
  }

  /**
   * Start a Research run and return the raw SSE response. Callers can consume
   * `response.body` with their preferred SSE parser without buffering the run.
   */
  run(request: ResearchRunRequest, signal?: AbortSignal): Promise<Response> {
    return this.request('/harness/run', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      let payload: ErrorPayload = {};
      try {
        payload = await response.json() as ErrorPayload;
      } catch {
        // The status remains actionable even when a proxy returns non-JSON.
      }
      throw new ResearchApiError(
        response.status,
        payload.code,
        payload.message ?? `Research API request failed with HTTP ${response.status}`,
      );
    }
    return response;
  }
}
