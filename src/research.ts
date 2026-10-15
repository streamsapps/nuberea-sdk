interface LibraryFileBase {
  referenceId: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  importedAt: string;
  expiresAt?: string;
}

export type LibraryFile = LibraryFileBase & (
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
  libraryFileIds?: string[];
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

  async importGoogleDriveLibraryFile(
    fileId: string,
    googleAccessToken: string,
  ): Promise<LibraryFile> {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) {
      throw new TypeError('fileId must be a Google Drive file identifier');
    }
    if (!googleAccessToken || /\s/.test(googleAccessToken)) {
      throw new TypeError('googleAccessToken is required');
    }
    const response = await this.request('/library/files/google-drive', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Google-Drive-Token': googleAccessToken,
      },
      body: JSON.stringify({ fileId }),
    });
    return ((await response.json()) as { reference: LibraryFile }).reference;
  }

  async importDeviceLibraryFile(
    name: string,
    mediaType: string,
    content: Uint8Array,
  ): Promise<LibraryFile> {
    if (!name.trim()) throw new TypeError('name is required');
    if (!mediaType.trim()) throw new TypeError('mediaType is required');
    const response = await this.request('/library/files/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(name),
        'X-File-Media-Type': mediaType,
      },
      body: Buffer.from(content),
    });
    return ((await response.json()) as { reference: LibraryFile }).reference;
  }

  async getLibraryFileDownloadUrl(referenceId: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(referenceId)) {
      throw new TypeError('referenceId must be a 64-character SHA-256 identifier');
    }
    const response = await this.request(
      `/library/files/${encodeURIComponent(referenceId)}/download`,
    );
    return ((await response.json()) as { url: string }).url;
  }

  async listLibraryFiles(): Promise<LibraryFile[]> {
    const response = await this.request('/library/files');
    return ((await response.json()) as { items: LibraryFile[] }).items;
  }

  async renameLibraryFile(referenceId: string, fileName: string): Promise<LibraryFile> {
    if (!/^[a-f0-9]{64}$/.test(referenceId)) {
      throw new TypeError('referenceId must be a 64-character SHA-256 identifier');
    }
    if (!fileName.trim()) throw new TypeError('fileName is required');
    const response = await this.request(`/library/files/${referenceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: fileName }),
    });
    return response.json() as Promise<LibraryFile>;
  }

  async deleteLibraryFile(referenceId: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(referenceId)) {
      throw new TypeError('referenceId must be a 64-character SHA-256 identifier');
    }
    await this.request(`/library/files/${referenceId}`, { method: 'DELETE' });
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
