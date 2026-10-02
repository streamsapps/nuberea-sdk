import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_STUDIO_ARTIFACT_BYTES, StudioClient, parseArtifact, parseResearchRun, type ResearchRun } from './studio.js';

const workspaceId = '12345678-1234-4234-8234-123456789012';
const runId = '12345678-1234-4234-8234-123456789013';
const receipt = (overrides: Partial<ResearchRun> = {}): ResearchRun => ({
  runId, workspaceId, goal: 'Plot a sine wave', mode: 'compute', status: 'queued',
  createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
  lastSequence: 0, cancellationRequested: false, ...overrides,
});

describe('durable Studio runs', () => {
  it('admits a persistent job with stable retry keys rather than waiting on SSE', async () => {
    const calls: { path: string; key: string | null; body: unknown }[] = [];
    const client = new StudioClient(async () => 'token', undefined, async (url, init) => {
      calls.push({
        path: new URL(String(url)).pathname, key: new Headers(init?.headers).get('Idempotency-Key'),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify(String(url).endsWith('/research-runs') ? receipt() : { workspaceId }));
    });
    const options = { mode: 'compute' as const, idempotencyKey: 'stable-research-key' };
    expect((await client.submit('Plot a sine wave', options)).runId).toBe(runId);
    await client.submit('Plot a sine wave', options);
    expect(calls[0].key).toBe(calls[2].key);
    expect(calls[1].key).toBe('stable-research-key');
    expect(calls[1].body).toEqual({ goal: 'Plot a sine wave', mode: 'compute' });
    expect(calls.every((call) => !call.path.endsWith('/research'))).toBe(true);
  });
  it('restores a completed run by event cursor and persisted terminal outcome', async () => {
    const client = new StudioClient(async () => 'token', undefined, async (url) => {
      expect(new URL(String(url)).searchParams.get('after')).toBe('2');
      return new Response(JSON.stringify({
        events: [{ sequence: 3, event: 'done', data: { message: 'Plot complete' }, createdAt: '2026-10-02T00:00:01.000Z' }],
        cursor: 3, run: receipt({ status: 'completed', lastSequence: 3, outcome: { event: 'done', data: { message: 'Plot complete' } } }),
      }));
    });
    const run = await client.follow(workspaceId, runId, undefined, undefined, 2);
    expect(run.status).toBe('completed');
    expect(run.outcome?.data.message).toBe('Plot complete');
  });
  it('aborting a subscription does not submit a cancellation or a second job', async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const client = new StudioClient(async () => 'token', undefined, async (url, init) => {
      calls.push(`${init?.method} ${new URL(String(url)).pathname}`);
      return new Response(JSON.stringify({
        events: [{ sequence: 1, event: 'progress', data: { message: 'Running' }, createdAt: '2026-10-02T00:00:01.000Z' }],
        cursor: 1, run: receipt({ status: 'running', lastSequence: 1 }),
      }));
    });
    await expect(client.follow(workspaceId, runId, () => controller.abort(), controller.signal)).rejects.toThrow('does not cancel remote work');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('GET');
    expect(calls[0]).not.toContain('/cancel');
  });
  it('requires explicit cancellation and refuses other-run status', async () => {
    const client = new StudioClient(async () => 'token', undefined, async (url, init) => {
      if (String(url).endsWith('/cancel')) {
        expect(init?.method).toBe('POST');
        expect(init?.body).toBe('{}');
        return new Response(JSON.stringify(receipt({ cancellationRequested: true })));
      }
      return new Response(JSON.stringify(receipt({ runId: workspaceId })));
    });
    expect((await client.cancel(workspaceId, runId)).cancellationRequested).toBe(true);
    await expect(client.status(workspaceId, runId)).rejects.toThrow('another run');
  });
  it('rejects malformed run IDs and event cursors that skip returned data', async () => {
    expect(() => parseResearchRun(receipt({ runId: '-'.repeat(36) }))).toThrow();
    const client = new StudioClient(async () => 'token', undefined, async () => new Response(JSON.stringify({
      events: [], cursor: 9, run: receipt({ lastSequence: 9 }),
    })));
    await expect(client.events(workspaceId, runId)).rejects.toThrow('cursor skipped');
  });
});

describe('Studio local artifact delivery', () => {
  it('validates paths and manifests before any local write', () => {
    expect(() => parseArtifact({ name: '../evil.md' })).toThrow();
    const artifact = { artifactId: 'a'.repeat(64), workspaceId, name: 'plot.png', sha256: 'b'.repeat(64), size: 8 };
    for (const field of ['name', 'artifactId', 'sha256', 'workspaceId'] as const) {
      expect(() => parseArtifact({ ...artifact, [field]: `${artifact[field]}\n` })).toThrow();
    }
    expect(() => new StudioClient(async () => 'token', 'http://evil.test')).toThrow();
  });
  it('verifies checksum, writes only an approved filename and never overwrites or executes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nuberea-studio-test-'));
    const content = '# Research';
    const artifact = {
      artifactId: 'a'.repeat(64), workspaceId: '12345678-1234-4234-8234-123456789012',
      name: 'report.md', size: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    };
    let calls = 0;
    const client = new StudioClient(async () => 'scoped-token', undefined, async (_url, init) => {
      calls += 1;
      if (calls % 2 === 1) return new Response(JSON.stringify({ url: 'https://test.s3.us-west-2.amazonaws.com/report.md' }));
      expect(init?.headers).toBeUndefined();
      return new Response(content);
    });
    try {
      const path = await client.download(artifact, dir);
      expect(await readFile(path, 'utf8')).toBe(content);
      await expect(client.download(artifact, dir)).rejects.toThrow();
    } finally { await rm(dir, { recursive: true }); }
  });
  for (const name of ['analysis.py', 'plot.png', 'simulation.npz', 'animation.mp4']) {
    it(`downloads real bounded ${name} bytes without executing them`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'nuberea-studio-binary-test-'));
      const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
      const artifact = {
        artifactId: 'a'.repeat(64), workspaceId: '12345678-1234-4234-8234-123456789012', name,
        size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      const client = new StudioClient(async () => 'scoped-token', undefined, async (url, init) => {
        if (String(url).endsWith('/download')) return new Response(JSON.stringify({ url: 'https://test.s3.us-west-2.amazonaws.com/file' }));
        expect(init?.headers).toBeUndefined();
        return new Response(bytes);
      });
      try {
        expect(await readFile(await client.download(artifact, dir))).toEqual(Buffer.from(bytes));
      } finally { await rm(dir, { recursive: true }); }
    });
  }
  it('rejects oversized manifests and a response larger than its declared bytes before writing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nuberea-studio-bounds-test-'));
    const artifact = {
      artifactId: 'a'.repeat(64), workspaceId: '12345678-1234-4234-8234-123456789012',
      name: 'plot.png', size: 1, sha256: 'b'.repeat(64),
    };
    expect(() => parseArtifact({ ...artifact, size: MAX_STUDIO_ARTIFACT_BYTES + 1 })).toThrow();
    const client = new StudioClient(async () => 'token', undefined, async (url) =>
      String(url).endsWith('/download')
        ? new Response(JSON.stringify({ url: 'https://test.s3.us-west-2.amazonaws.com/file' }))
        : new Response(new Uint8Array([1, 2])));
    try {
      await expect(client.download(artifact, dir)).rejects.toThrow('size limit');
      await expect(readFile(join(dir, artifact.name))).rejects.toThrow();
    } finally { await rm(dir, { recursive: true }); }
  });
  it('does not write bytes with a checksum mismatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nuberea-studio-hash-test-'));
    const artifact = {
      artifactId: 'a'.repeat(64), workspaceId: '12345678-1234-4234-8234-123456789012',
      name: 'plot.png', size: 1, sha256: 'b'.repeat(64),
    };
    const client = new StudioClient(async () => 'token', undefined, async (url) =>
      String(url).endsWith('/download')
        ? new Response(JSON.stringify({ url: 'https://test.s3.us-west-2.amazonaws.com/file' }))
        : new Response(new Uint8Array([1])));
    try {
      await expect(client.download(artifact, dir)).rejects.toThrow('checksum/size mismatch');
      await expect(readFile(join(dir, artifact.name))).rejects.toThrow();
    } finally { await rm(dir, { recursive: true }); }
  });
});
