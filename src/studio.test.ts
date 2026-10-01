import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioClient, parseArtifact } from './studio.js';

describe('Studio local artifact delivery', () => {
  it('validates paths and manifests before any local write', () => {
    expect(() => parseArtifact({ name: '../evil.md' })).toThrow();
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
});
