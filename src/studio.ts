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
  checkpointId?: string;
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
  mediaType?: string;
  createdAt?: string;
}
export interface WorkspaceCheckpoint {
  version: 1;
  checkpointId: string;
  workspaceId: string;
  label: string;
  createdAt: string;
  files: (ResearchArtifact & { mediaType: string; createdAt: string; path: string })[];
  totalBytes: number;
  manifestSha256: string;
  memoryRestored: false;
  codeReplayed: false;
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
    || (value.checkpointId !== undefined && typeof value.checkpointId !== 'string')
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
    ...(typeof value.checkpointId === 'string' ? { checkpointId: uuid(value.checkpointId) } : {}),
    ...(outcome ? { outcome } : {}),
  };
}

export function parseCheckpoint(value: unknown): WorkspaceCheckpoint {
  if (!record(value) || value.version !== 1 || typeof value.checkpointId !== 'string'
    || typeof value.workspaceId !== 'string' || typeof value.label !== 'string'
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 32
    || typeof value.totalBytes !== 'number' || !Number.isSafeInteger(value.totalBytes)
    || value.totalBytes > 64 * 1024 * 1024 || value.totalBytes < 0
    || typeof value.manifestSha256 !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(value.manifestSha256)
    || value.memoryRestored !== false || value.codeReplayed !== false) throw new Error('Invalid checkpoint manifest');
  const workspaceId = uuid(value.workspaceId);
  const files = value.files.map((item) => {
    const artifact = parseArtifact(item);
    if (!record(item) || typeof item.mediaType !== 'string' || typeof item.createdAt !== 'string'
      || !Number.isFinite(Date.parse(item.createdAt)) || item.path !== `outputs/${artifact.name}`
      || artifact.workspaceId !== workspaceId) throw new Error('Invalid checkpoint file');
    return { ...artifact, mediaType: item.mediaType, createdAt: item.createdAt, path: item.path };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length
    || files.reduce((sum, file) => sum + file.size, 0) !== value.totalBytes
    || createHash('sha256').update(JSON.stringify(files)).digest('hex') !== value.manifestSha256) {
    throw new Error('Checkpoint integrity failed');
  }
  return { version: 1, checkpointId: uuid(value.checkpointId), workspaceId, label: value.label,
    createdAt: value.createdAt, files, totalBytes: value.totalBytes, manifestSha256: value.manifestSha256,
    memoryRestored: false, codeReplayed: false };
}
export function parseArtifact(value: unknown): ResearchArtifact {
  if (!record(value) || typeof value.artifactId !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(value.artifactId)
    || typeof value.workspaceId !== 'string' || typeof value.name !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.(md|csv|json|txt|py|png|jpg|jpeg|pdf|mp4|webm|npy|npz|parquet)(?![\s\S])/.test(value.name)
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(value.sha256)
    || typeof value.size !== 'number' || !Number.isInteger(value.size) || value.size < 0 || value.size > MAX_STUDIO_ARTIFACT_BYTES
    || (value.mediaType !== undefined && typeof value.mediaType !== 'string')
    || (value.createdAt !== undefined && (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))))) {
    throw new Error('Invalid research deliverable manifest');
  }
  return { artifactId: value.artifactId, workspaceId: uuid(value.workspaceId), name: value.name, sha256: value.sha256, size: value.size,
    ...(typeof value.mediaType === 'string' ? { mediaType: value.mediaType } : {}),
    ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}) };
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
    if (!response.ok) {
      const error = record(data) && record(data.error) ? data.error : data;
      throw new Error(record(error) && typeof error.message === 'string' ? error.message : `Studio request failed (${response.status})`);
    }
    return data;
  }
  async files(workspaceId: string): Promise<ResearchArtifact[]> {
    const data = await this.request(`/${uuid(workspaceId)}/artifacts`);
    if (!record(data) || !Array.isArray(data.artifacts)) throw new Error('Invalid deliverable list');
    return data.artifacts.map(parseArtifact);
  }
  async submit(goal: string, options: { mode?: StudioMode; workspaceId?: string; idempotencyKey?: string; checkpointId?: string } = {}): Promise<ResearchRun> {
    if (!goal.trim() || goal.length > 8000) throw new Error('Provide a research brief of at most 8000 characters');
    if (options.checkpointId && !options.workspaceId) throw new Error('Restoring a checkpoint requires its owned workspace ID');
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
    const result = parseResearchRun(await this.request(`/${uuid(workspaceId)}/research-runs`, {
      goal: goal.trim(), mode: selectedMode, ...(options.checkpointId ? { checkpointId: uuid(options.checkpointId) } : {}),
    }, { key }));
    if (result.workspaceId !== workspaceId) throw new Error('Research admission returned another workspace');
    return result;
  }
  async checkpoints(workspaceId: string): Promise<WorkspaceCheckpoint[]> {
    const result: WorkspaceCheckpoint[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const data = await this.request(`/${uuid(workspaceId)}/checkpoints${cursor ? `?cursor=${uuid(cursor)}` : ''}`);
      if (!record(data) || !Array.isArray(data.checkpoints)) throw new Error('Invalid checkpoint history');
      const checkpoints = data.checkpoints.map(parseCheckpoint);
      if (checkpoints.some((item) => item.workspaceId !== workspaceId)) throw new Error('Checkpoint history returned another workspace');
      result.push(...checkpoints);
      if (data.nextCursor === undefined) return result.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      if (typeof data.nextCursor !== 'string' || data.nextCursor === cursor) throw new Error('Checkpoint history made no progress');
      cursor = uuid(data.nextCursor);
    }
    throw new Error('Checkpoint history exceeds the bounded page limit');
  }
  async checkpoint(workspaceId: string, artifactIds: string[], options: { label?: string; key?: string; signal?: AbortSignal } = {}): Promise<WorkspaceCheckpoint> {
    if (artifactIds.length < 1 || artifactIds.length > 32 || artifactIds.some((id) => !/^[a-f0-9]{64}(?![\s\S])/.test(id))
      || new Set(artifactIds).size !== artifactIds.length) {
      throw new Error('Select 1-32 owned checkpoint files');
    }
    if (options.label !== undefined && (!options.label.trim() || options.label.length > 120)) throw new Error('Checkpoint label must be 1-120 characters');
    if (options.key !== undefined && !/^[A-Za-z0-9_-]{8,128}(?![\s\S])/.test(options.key)) throw new Error('Invalid checkpoint idempotency key');
    const admitted = await this.request(`/${uuid(workspaceId)}/checkpoints`, {
      artifactIds, ...(options.label ? { label: options.label } : {}),
    }, { ...(options.key ? { key: options.key } : {}), ...(options.signal ? { signal: options.signal } : {}) });
    const done = await this.waitOperation(workspaceId, admitted, 'checkpoint', options.signal);
    const checkpoint = parseCheckpoint(done.checkpoint);
    if (checkpoint.workspaceId !== workspaceId) throw new Error('Checkpoint receipt returned another workspace');
    return checkpoint;
  }
  async resumeCompute(workspaceId: string, checkpointId: string, options: { key?: string; signal?: AbortSignal } = {}) {
    if (options.key !== undefined && !/^[A-Za-z0-9_-]{8,128}(?![\s\S])/.test(options.key)) throw new Error('Invalid restore idempotency key');
    const admitted = await this.request(`/${uuid(workspaceId)}/operations`, {
      kind: 'resume', checkpointId: uuid(checkpointId), sessionTimeoutSeconds: 900,
    }, { ...(options.key ? { key: options.key } : {}), ...(options.signal ? { signal: options.signal } : {}) });
    const done = await this.waitOperation(workspaceId, admitted, 'resume', options.signal);
    const checkpoint = parseCheckpoint(done.checkpoint);
    if (checkpoint.checkpointId !== checkpointId || checkpoint.workspaceId !== workspaceId) throw new Error('Restore receipt returned another checkpoint');
    return { operationId: String(done.operationId), checkpoint, memoryRestored: false, codeReplayed: false };
  }
  private async waitOperation(workspaceId: string, admitted: unknown, kind: 'checkpoint' | 'resume', signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!record(admitted) || typeof admitted.operationId !== 'string' || admitted.workspaceId !== workspaceId || admitted.kind !== kind) {
      throw new Error('Invalid checkpoint operation admission');
    }
    const operationId = uuid(admitted.operationId);
    let current = admitted;
    for (let polls = 0; polls < 600; polls++) {
      if (current.operationId !== operationId || current.workspaceId !== workspaceId || current.kind !== kind) {
        throw new Error('Checkpoint polling returned another operation');
      }
      if (current.status === 'succeeded') return current;
      if (current.status === 'failed' || current.status === 'indeterminate') {
        throw new Error(`Checkpoint operation ${operationId} ${current.status}: ${String(current.errorCode ?? 'check saved workspace state')}`);
      }
      if (current.status !== 'queued' && current.status !== 'running') throw new Error('Invalid checkpoint operation status');
      await sleep(1000, undefined, signal ? { signal } : {});
      const next = await this.request(`/${uuid(workspaceId)}/operations/${operationId}`, undefined, signal ? { signal } : {});
      if (!record(next)) throw new Error('Invalid checkpoint operation receipt');
      current = next;
    }
    throw new Error(`Checkpoint operation ${operationId} is still pending; reconcile it instead of resubmitting`);
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
  async run(goal: string, onProgress: (message: string) => void = () => {}, signal?: AbortSignal, selectedMode: StudioMode = 'auto',
    options: { workspaceId?: string; checkpointId?: string } = {}) {
    signal?.throwIfAborted();
    const submitted = await this.submit(goal, { mode: selectedMode, ...options });
    onProgress(`Workspace: ${submitted.workspaceId}; run: ${submitted.runId}`);
    const run = await this.follow(submitted.workspaceId, submitted.runId, onProgress, signal);
    if (run.status !== 'completed' || run.outcome?.event !== 'done') {
      throw new Error(record(run.outcome?.data) && typeof run.outcome.data.message === 'string'
        ? `${run.outcome.data.message} (run ${run.runId})` : `Research ${run.status}; run ${run.runId}. Inspect saved files before continuing.`);
    }
    const artifacts = Array.isArray(run.outcome.data.artifacts)
      ? run.outcome.data.artifacts.map(parseArtifact) : await this.files(run.workspaceId);
    if (artifacts.some((file) => file.workspaceId !== run.workspaceId)) throw new Error('Research returned another workspace file');
    return { workspaceId: run.workspaceId, runId: run.runId, artifacts, outcome: run.outcome.data };
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
