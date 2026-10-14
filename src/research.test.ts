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

  it('does not reuse the SDK OAuth token as a Firebase chat credential', async () => {
    const client = new NuBerea({
      accessToken: 'oauth-access-token',
      chatApiUrl: 'http://localhost:8000/v1',
    });
    await expect(client.research.getReferenceDownloadUrl('a'.repeat(64)))
      .rejects.toThrow('Firebase ID token');
  });
});
