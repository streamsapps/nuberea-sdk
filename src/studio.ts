import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export interface ResearchArtifact {
  artifactId: string;
  workspaceId: string;
  name: string;
  sha256: string;
  size: number;
}
const uuid = (value: string) => {
  if (!/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Invalid workspace ID');
  return value;
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export function parseArtifact(value: unknown): ResearchArtifact {
  if (!record(value) || typeof value.artifactId !== 'string' || !/^[a-f0-9]{64}$/.test(value.artifactId)
    || typeof value.workspaceId !== 'string' || typeof value.name !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.(md|csv|json|txt)$/.test(value.name)
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.size !== 'number' || !Number.isInteger(value.size) || value.size < 0 || value.size > 24576) {
    throw new Error('Invalid research deliverable manifest');
  }
  return { artifactId: value.artifactId, workspaceId: uuid(value.workspaceId), name: value.name, sha256: value.sha256, size: value.size };
}

export class StudioClient {
  private readonly base: string;
  constructor(private readonly getToken: () => Promise<string>, base = 'https://api.nubereappe.com/v1', private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Studio requires a credential-free HTTPS API base');
    this.base = base.replace(/\/+$/, '') + '/workspaces';
  }
  private async request(path: string, body?: unknown) {
    const response = await this.fetcher(this.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${await this.getToken()}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
    });
    const data: unknown = await response.json();
    if (!response.ok) throw new Error(record(data) && typeof data.message === 'string' ? data.message : `Studio request failed (${response.status})`);
    return data;
  }
  async files(workspaceId: string): Promise<ResearchArtifact[]> {
    const data = await this.request(`/${uuid(workspaceId)}/artifacts`);
    if (!record(data) || !Array.isArray(data.artifacts)) throw new Error('Invalid deliverable list');
    return data.artifacts.map(parseArtifact);
  }
  async run(goal: string, onProgress: (message: string) => void = () => {}, signal?: AbortSignal) {
    if (!goal.trim() || goal.length > 8000) throw new Error('Provide a research brief of at most 8000 characters');
    const created = await this.request('', { name: goal.trim().slice(0, 100) });
    if (!record(created) || typeof created.workspaceId !== 'string') throw new Error('Invalid research workspace');
    const workspaceId = uuid(created.workspaceId);
    onProgress(`Workspace: ${workspaceId}`);
    const response = await this.fetcher(`${this.base}/${workspaceId}/research`, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${await this.getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal }), signal,
    });
    if (!response.ok || !response.body) throw new Error(`Research admission failed (${response.status}); workspace ${workspaceId}`);
    const reader = response.body.getReader();
    let buffer = '';
    let completed = false;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
        if (buffer.length > 1024 * 1024) throw new Error('Research frame exceeded its size limit');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = frame.split('\n');
          const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
          const raw = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
          if (!raw) continue;
          const data: unknown = JSON.parse(raw);
          if (record(data) && event === 'progress' && typeof data.message === 'string') onProgress(data.message);
          if (event === 'error') throw new Error(record(data) && typeof data.message === 'string' ? data.message : 'Research failed');
          if (event === 'done') completed = true;
        }
      }
    } finally { reader.releaseLock(); }
    if (!completed) throw new Error(`Research outcome unknown. Inspect workspace ${workspaceId}; do not automatically rerun.`);
    return { workspaceId, artifacts: await this.files(workspaceId) };
  }
  async download(artifact: ResearchArtifact, outputDirectory: string): Promise<string> {
    const manifest = parseArtifact(artifact);
    const data = await this.request(`/${manifest.workspaceId}/artifacts/${manifest.artifactId}/download`);
    if (!record(data) || typeof data.url !== 'string') throw new Error('Invalid deliverable download');
    const url = new URL(data.url);
    if (url.protocol !== 'https:' || !/\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)) throw new Error('Invalid artifact storage URL');
    const response = await this.fetcher(url, { redirect: 'error' });
    if (!response.ok) throw new Error('Deliverable download failed');
    if (!response.body) throw new Error('Deliverable response was empty');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 24576) {
          await reader.cancel();
          throw new Error('Deliverable exceeded its size limit');
        }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    if (bytes.byteLength !== manifest.size || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
      throw new Error('Deliverable checksum/size mismatch; no local file written');
    }
    await mkdir(resolve(outputDirectory), { recursive: true });
    const destination = join(await realpath(resolve(outputDirectory)), manifest.name);
    const handle = await open(destination, 'wx', 0o600);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    return destination;
  }
}
