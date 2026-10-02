import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export type StudioMode = 'auto' | 'research' | 'compute';
export type ResearchRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface ResearchRun {
  runId: string;
  workspaceId: string;
  goal: string;
  mode: StudioMode;
  status: ResearchRunStatus;
  createdAt: string;
  updatedAt: string;
  lastSequence: number;
  cancellationRequested: boolean;
  partialMessage?: string;
  outcome?: { event: 'done' | 'error'; data: Record<string, unknown> };
}
export interface ResearchRunEvent {
  sequence: number;
  event: string;
  data: unknown;
  createdAt: string;
}

export interface ResearchArtifact {
  artifactId: string;
  workspaceId: string;
  name: string;
  sha256: string;
  size: number;
}
export const MAX_STUDIO_ARTIFACT_BYTES = 8 * 1024 * 1024;
const uuid = (value: string) => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/i.test(value)) throw new Error('Invalid workspace/run ID');
  return value;
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const mode = (value: unknown): value is StudioMode => value === 'auto' || value === 'research' || value === 'compute';
const status = (value: unknown): value is ResearchRunStatus =>
  value === 'queued' || value === 'running' || value === 'completed'
  || value === 'failed' || value === 'cancelled' || value === 'interrupted';
export function parseResearchRun(value: unknown): ResearchRun {
  if (!record(value) || typeof value.runId !== 'string' || typeof value.workspaceId !== 'string'
    || typeof value.goal !== 'string' || !mode(value.mode) || !status(value.status)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
    || typeof value.lastSequence !== 'number' || !Number.isSafeInteger(value.lastSequence) || value.lastSequence < 0
    || typeof value.cancellationRequested !== 'boolean'
    || (value.partialMessage !== undefined && typeof value.partialMessage !== 'string')) {
    throw new Error('Invalid persistent research run');
  }
  let outcome: ResearchRun['outcome'];
  if (value.outcome !== undefined) {
    if (!record(value.outcome) || (value.outcome.event !== 'done' && value.outcome.event !== 'error')
      || !record(value.outcome.data)) throw new Error('Invalid research terminal outcome');
    outcome = { event: value.outcome.event, data: value.outcome.data };
  }
  return {
    runId: uuid(value.runId), workspaceId: uuid(value.workspaceId), goal: value.goal,
    mode: value.mode, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt,
    lastSequence: value.lastSequence, cancellationRequested: value.cancellationRequested,
    ...(typeof value.partialMessage === 'string' ? { partialMessage: value.partialMessage } : {}),
    ...(outcome ? { outcome } : {}),
  };
}
export function parseArtifact(value: unknown): ResearchArtifact {
  if (!record(value) || typeof value.artifactId !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(value.artifactId)
    || typeof value.workspaceId !== 'string' || typeof value.name !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.(md|csv|json|txt|py|png|jpg|jpeg|pdf|mp4|webm|npy|npz|parquet)(?![\s\S])/.test(value.name)
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(value.sha256)
    || typeof value.size !== 'number' || !Number.isInteger(value.size) || value.size < 0 || value.size > MAX_STUDIO_ARTIFACT_BYTES) {
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
  private async request(path: string, body?: unknown, options: { key?: string; signal?: AbortSignal } = {}) {
    const response = await this.fetcher(this.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${await this.getToken()}`, 'Content-Type': 'application/json', 'Idempotency-Key': options.key ?? randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: options.signal,
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
  async submit(goal: string, options: { mode?: StudioMode; workspaceId?: string; idempotencyKey?: string } = {}): Promise<ResearchRun> {
    if (!goal.trim() || goal.length > 8000) throw new Error('Provide a research brief of at most 8000 characters');
    const selectedMode = options.mode ?? 'auto';
    if (!mode(selectedMode)) throw new Error('Invalid Studio run mode');
    const key = options.idempotencyKey ?? randomUUID();
    if (!/^[A-Za-z0-9_-]{8,128}(?![\s\S])/.test(key)) throw new Error('Invalid research idempotency key');
    let workspaceId = options.workspaceId;
    if (!workspaceId) {
      const created = await this.request('', { name: goal.trim().slice(0, 100) }, {
        key: `studio-${createHash('sha256').update(key).digest('hex')}`,
      });
      if (!record(created) || typeof created.workspaceId !== 'string') throw new Error('Invalid research workspace');
      workspaceId = created.workspaceId;
    }
    const result = parseResearchRun(await this.request(`/${uuid(workspaceId)}/research-runs`, { goal: goal.trim(), mode: selectedMode }, { key }));
    if (result.workspaceId !== workspaceId) throw new Error('Research admission returned another workspace');
    return result;
  }
  async sessions(workspaceId: string): Promise<ResearchRun[]> {
    const data = await this.request(`/${uuid(workspaceId)}/research-runs`);
    if (!record(data) || !Array.isArray(data.runs)) throw new Error('Invalid research history');
    const runs = data.runs.map(parseResearchRun);
    if (runs.some((run) => run.workspaceId !== workspaceId)) throw new Error('Research history returned another workspace');
    return runs;
  }
  async status(workspaceId: string, runId: string, signal?: AbortSignal): Promise<ResearchRun> {
    const run = parseResearchRun(await this.request(`/${uuid(workspaceId)}/research-runs/${uuid(runId)}`, undefined, { signal }));
    if (run.runId !== runId || run.workspaceId !== workspaceId) throw new Error('Research status returned another run');
    return run;
  }
  async cancel(workspaceId: string, runId: string): Promise<ResearchRun> {
    const run = parseResearchRun(await this.request(`/${uuid(workspaceId)}/research-runs/${uuid(runId)}/cancel`, {}));
    if (run.runId !== runId || run.workspaceId !== workspaceId) throw new Error('Cancellation returned another run');
    return run;
  }
  async events(workspaceId: string, runId: string, after = 0, signal?: AbortSignal) {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid event cursor');
    const data = await this.request(`/${uuid(workspaceId)}/research-runs/${uuid(runId)}/events?after=${after}`, undefined, { signal });
    if (!record(data) || !Array.isArray(data.events) || typeof data.cursor !== 'number'
      || !Number.isSafeInteger(data.cursor) || data.cursor < after) throw new Error('Invalid research event page');
    const run = parseResearchRun(data.run);
    if (run.runId !== runId || run.workspaceId !== workspaceId) throw new Error('Research events returned another run');
    const events: ResearchRunEvent[] = data.events.map((event: unknown) => {
      if (!record(event) || typeof event.sequence !== 'number' || !Number.isSafeInteger(event.sequence) || event.sequence < 1
        || typeof event.event !== 'string' || typeof event.createdAt !== 'string') throw new Error('Invalid research event');
      return { sequence: event.sequence, event: event.event, data: event.data, createdAt: event.createdAt };
    });
    let previous = after;
    for (const event of events) {
      if (event.sequence <= previous || event.sequence > data.cursor) throw new Error('Invalid research event order');
      previous = event.sequence;
    }
    if (data.cursor !== previous) throw new Error('Research event cursor skipped data');
    return { events, cursor: data.cursor, run };
  }
  async follow(workspaceId: string, runId: string, onProgress: (message: string) => void = () => {}, signal?: AbortSignal, after = 0): Promise<ResearchRun> {
    let cursor = after;
    try {
      while (true) {
        const page = await this.events(workspaceId, runId, cursor, signal);
        for (const event of page.events) {
          if (event.event === 'progress' && record(event.data) && typeof event.data.message === 'string') onProgress(event.data.message);
        }
        cursor = page.cursor;
        if (page.run.status !== 'queued' && page.run.status !== 'running') return page.run;
        await sleep(2000, undefined, { signal });
      }
    } catch (error) {
      throw new Error(`Stopped following run ${runId} in workspace ${workspaceId} at event ${cursor}. This does not cancel remote work; inspect or reconnect, do not automatically rerun.`, { cause: error });
    }
  }
  async run(goal: string, onProgress: (message: string) => void = () => {}, signal?: AbortSignal, selectedMode: StudioMode = 'auto') {
    signal?.throwIfAborted();
    const submitted = await this.submit(goal, { mode: selectedMode });
    onProgress(`Workspace: ${submitted.workspaceId}; run: ${submitted.runId}`);
    const run = await this.follow(submitted.workspaceId, submitted.runId, onProgress, signal);
    if (run.status !== 'completed' || run.outcome?.event !== 'done') {
      throw new Error(record(run.outcome?.data) && typeof run.outcome.data.message === 'string'
        ? `${run.outcome.data.message} (run ${run.runId})` : `Research ${run.status}; run ${run.runId}. Inspect saved files before continuing.`);
    }
    return { workspaceId: run.workspaceId, runId: run.runId, artifacts: await this.files(run.workspaceId), outcome: run.outcome.data };
  }
  async download(artifact: ResearchArtifact, outputDirectory: string): Promise<string> {
    const manifest = parseArtifact(artifact);
    const data = await this.request(`/${manifest.workspaceId}/artifacts/${manifest.artifactId}/download`);
    if (!record(data) || typeof data.url !== 'string') throw new Error('Invalid deliverable download');
    const url = new URL(data.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || !/\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)) throw new Error('Invalid artifact storage URL');
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
        if (length > MAX_STUDIO_ARTIFACT_BYTES || length > manifest.size) {
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
