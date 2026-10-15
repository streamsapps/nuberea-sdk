import { describe, expect, it, vi } from 'vitest';
import { ResearchClient } from './research.js';
import { NuBerea } from './client.js';

describe('ResearchClient', () => {
  it('imports a Drive reference with separate NuBerea and Google credentials', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      reference: {
        referenceId: 'a'.repeat(64),
        name: 'notes.txt',
        mediaType: 'text/plain',
        size: 5,
        sha256: 'b'.repeat(64),
        importedAt: '2026-10-14T00:00:00.000Z',
        provider: 'google_drive',
        providerFileId: 'drive-file-12345',
      },
    }), { status: 201 }));
    const client = new ResearchClient({
      baseUrl: 'http://localhost:8000/v1/',
      getToken: async () => 'nuberea-token',
      fetch: fetcher,
    });

    const reference = await client.importGoogleDriveReference(
      'drive-file-12345',
      'google-token',
    );
    expect(reference.referenceId).toBe('a'.repeat(64));
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/v1/harness/references/google-drive');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer nuberea-token');
    expect(new Headers(init?.headers).get('x-google-drive-token')).toBe('google-token');
    expect(init?.body).toBe(JSON.stringify({ fileId: 'drive-file-12345' }));
  });

  it('sends reference IDs only to the Research run endpoint', async () => {
    const fetcher = vi.fn(async () => new Response('event: done\ndata: {}\n\n'));
    const client = new ResearchClient({
      baseUrl: 'http://localhost:8000/v1',
      getToken: async () => 'nuberea-token',
      fetch: fetcher,
    });

    await client.run({
      userMessage: 'Review this.',
      gptModel: '5.6 terra',
      referenceIds: ['a'.repeat(64)],
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/v1/harness/run');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      referenceIds: ['a'.repeat(64)],
    });
  });

  it('uploads a device file through the Research-only binary endpoint', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      reference: {
        referenceId: 'a'.repeat(64),
        name: 'notes.txt',
        mediaType: 'text/plain',
        size: 5,
        sha256: 'b'.repeat(64),
        importedAt: '2026-10-14T00:00:00.000Z',
        provider: 'device',
      },
    }), { status: 201 }));
    const client = new ResearchClient({
      baseUrl: 'http://localhost:8000/v1',
      getToken: async () => 'nuberea-token',
      fetch: fetcher,
    });
    const reference = await client.importDeviceReference(
      'notes.txt',
      'text/plain',
      new TextEncoder().encode('hello'),
    );

    expect(reference.provider).toBe('device');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/v1/harness/references/upload');
    expect(new Headers(init?.headers).get('x-file-name')).toBe('notes.txt');
    expect(new Headers(init?.headers).get('x-file-media-type')).toBe('text/plain');
    expect(Buffer.from(init?.body as Uint8Array).toString()).toBe('hello');
  });

  it('does not reuse the SDK OAuth token as a Firebase chat credential', async () => {
    const client = new NuBerea({
      accessToken: 'oauth-access-token',
      chatApiUrl: 'http://localhost:8000/v1',
    });
    await expect(client.research.getReferenceDownloadUrl('a'.repeat(64)))
      .rejects.toThrow('Firebase ID token');
  });

  it('lists, renames, and deletes attachment resources', async () => {
    const id = 'a'.repeat(64);
    const reference = {
      referenceId: id,
      name: 'notes.txt',
      mediaType: 'text/plain',
      size: 5,
      sha256: 'b'.repeat(64),
      importedAt: '2026-10-14T00:00:00.000Z',
      expiresAt: '2026-11-13T00:00:00.000Z',
      provider: 'device' as const,
    };
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (init?.method === 'PATCH') return new Response(JSON.stringify({ ...reference, name: 'renamed.txt' }));
      return new Response(JSON.stringify({ items: [reference], cursor: null }));
    });
    const client = new ResearchClient({
      baseUrl: 'http://localhost:8000/v1',
      getToken: async () => 'nuberea-token',
      fetch: fetcher,
    });

    expect(await client.listReferences()).toEqual([reference]);
    expect((await client.renameReference(id, 'renamed.txt')).name).toBe('renamed.txt');
    await client.deleteReference(id);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
