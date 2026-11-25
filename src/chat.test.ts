import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatClient, ChatError, type ChatRequest, type ChatResponse, type ReasoningSkillUsage, type ChatAttachment } from './chat.js';
import { NuBerea } from './client.js';
import { NuBereaAuth } from './auth.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const request: ChatRequest = { gptModel: '5.6 terra', userMessage: 'Audit the supplied inference.' };
const skills: ReasoningSkillUsage[] = [
  { instructionId: 'reasoning.claims_evidence', version: '1.0.0', title: 'Claims and evidence' },
  { instructionId: 'reasoning.synthesis_audit', version: '1.0.0', title: 'Synthesis and audit' },
];
const answer: ChatResponse = {
  message: 'שלום and λόγος', responseID: 'resp_fixture', isVerified: false, reasoningSkills: skills,
  sources: [{ collectionId: 'bible', label: 'Bible', shortLabel: 'Bible', kind: 'text' }],
  annotations: [{ type: 'url_citation', url: 'https://example.test/source', startIndex: 0, endIndex: 4 }],
  answerKind: 'standard', workflowMode: null, workflowLabel: null,
  referenceActions: [{
    label: 'John 1:1', bookId: 'John', osisId: 'John', chapter: '1',
    readerTarget: { translationId: 'SBLGNT', bookKey: 'John', chapter: '1', verseStart: '1' },
  }],
  referenceActionMode: 'open_only',
  usage: { contextTokens: 100, inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, reasoningTokens: 0,
    totalTokens: 120, contextLimit: 250000, limitKind: 'compaction' },
};
const frame = (event: string, data: unknown) => `${event === 'message' ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;

function stream(text: string, width = 3, onCancel?: () => void) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += width) controller.enqueue(bytes.slice(i, i + width));
      controller.close();
    },
    cancel: onCancel,
  }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('native SDK chat', () => {
  it('uses the production chat endpoint, preserves the full request and separates Firebase from OAuth credentials', async () => {
    const fullRequest: ChatRequest = {
      ...request, previous_response_id: 'resp_previous',
      enabledCollections: ['bible'], workflowMode: 'read', reasoning: { effort: 'medium', mode: null },
      responseFormat: 'nuberea-rich',
      passageContext: {
        reference: 'John 1:1', translation: 'SBLGNT', selectedText: 'λόγος', selectionKind: 'verse',
        readerTarget: { translationId: 'SBLGNT', bookKey: 'John', chapter: '1', verseStart: '1' },
      },
    };
    const getFirebaseIdToken = vi.fn().mockResolvedValueOnce('firebase-1').mockResolvedValueOnce('firebase-2');
    const fetcher = vi.fn().mockImplementation(async () => stream(frame('done', answer)));
    vi.stubGlobal('fetch', fetcher);
    const client = new NuBerea({
      baseUrl: 'https://auth.nuberea.com', accessToken: 'oauth-only',
      firebaseIdToken: 'static-firebase', getFirebaseIdToken,
    });
    expect(await client.chat(fullRequest)).toEqual(answer);
    await client.chat(request);
    expect(getFirebaseIdToken).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url, init]) => ({
      url, token: new Headers(init.headers).get('Authorization'), redirect: init.redirect,
    }))).toEqual([
      { url: 'https://api.nuberea.com/v1/chat', token: 'Bearer firebase-1', redirect: 'error' },
      { url: 'https://api.nuberea.com/v1/chat', token: 'Bearer firebase-2', redirect: 'error' },
    ]);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(fullRequest);
  });

  it('uses in-memory browser credentials when only an MCP OAuth token was configured', async () => {
    const firebase = vi.spyOn(NuBereaAuth.prototype, 'getFirebaseIdToken').mockResolvedValue('browser-firebase');
    const fetcher = vi.fn().mockImplementation(async () => stream(frame('done', answer)));
    vi.stubGlobal('fetch', fetcher);
    await new NuBerea({ accessToken: 'oauth-only' }).chat(request);
    expect(firebase).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe('https://api.nuberea.com/v1/chat');
    expect(new Headers(fetcher.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer browser-firebase');
  });

  it('does not impose chat transport restrictions on existing self-hosted MCP clients', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: '2.0', id: 1, result: { content: [] },
    })));
    vi.stubGlobal('fetch', fetcher);
    const client = new NuBerea({ baseUrl: 'http://self-hosted.example.test', accessToken: 'oauth' });
    await client.tool('example');
    expect(fetcher.mock.calls[0][0]).toBe('http://self-hosted.example.test/mcp');
    await expect(client.chat(request)).rejects.toThrow('HTTPS API base');
  });

  it('streams skills before fragmented UTF-8 answer text and returns complete metadata without treating skills as tools', async () => {
    const lifecycle: string[] = [];
    const tool = { toolName: 'bible_get', arguments: { book: 'John' }, output: '', status: 'in_progress' };
    const text = [
      ': heartbeat\n\n',
      frame('thinking', { idleMs: 2000, elapsedMs: 2000, message: 'Thinking' }),
      frame('reasoning_skills', skills),
      frame('tool_call_start', tool),
      frame('tool_call', { ...tool, status: 'success', output: 'Text', toolCallId: 'call_1', durationMs: 42 }),
      frame('future_activity', { label: 'Future event' }),
      frame('message', { chunk: 'שלום ' }),
      frame('message', { chunk: 'and λόγος' }),
      frame('done', answer).trimEnd(),
    ].join('').replaceAll('\n', '\r\n');
    const client = new ChatClient(async () => 'fixture', undefined, async () => stream(text, 1));
    const result = await client.send(request, {
      onReasoningSkills: (value) => { expect(value).toEqual(skills); lifecycle.push('skills'); },
      onThinking: (value) => { expect(value.idleMs).toBe(2000); },
      onToolCallStart: (value) => { expect(value.status).toBe('in_progress'); lifecycle.push('tool-start'); },
      onToolCall: (value) => { expect(value.status).toBe('success'); lifecycle.push('tool'); },
      onChunk: (chunk) => { lifecycle.push(chunk); },
      onEvent: (event) => { if (event === 'future_activity') lifecycle.push('future'); },
    });
    expect(lifecycle).toEqual(['skills', 'tool-start', 'tool', 'future', 'שלום ', 'and λόγος']);
    expect(result).toEqual(answer);
    expect(result.toolCalls).toBeUndefined();
  });

  it('supports multiline SSE data and a no-skill response without emitting a false skill callback', async () => {
    const onReasoningSkills = vi.fn();
    const result = { message: 'Hello!', responseID: 'resp_hello', isVerified: false };
    const text = `event: done\ndata: {"message":"Hello!",\ndata: "responseID":"resp_hello","isVerified":false}\n\n`;
    expect(await new ChatClient(async () => 'fixture', undefined, async () => stream(text))
      .send(request, { onReasoningSkills })).toEqual(result);
    expect(onReasoningSkills).not.toHaveBeenCalled();
  });

  it('sends ephemeral files through normal chat and retains file provenance and the empty continuation ID', async () => {
    const attachment: ChatAttachment = {
      name: 'notes.txt', mediaType: 'text/plain', contentBase64: Buffer.from('Supplied evidence.').toString('base64'),
    };
    const response: ChatResponse = {
      ...answer, responseID: '', sources: [{
        collectionId: 'ephemeral_attachment:fixture', label: 'notes.txt', shortLabel: 'notes.txt',
        kind: 'file', mediaType: 'text/plain', sha256: 'fixture',
      }],
    };
    const fetcher = vi.fn().mockImplementation(async () => stream(frame('done', response)));
    const client = new ChatClient(async () => 'fixture', undefined, fetcher);
    expect(await client.send({ ...request, attachments: [attachment], previous_response_id: 'resp_previous' })).toEqual(response);
    expect(JSON.parse(fetcher.mock.calls[0][1].body).attachments).toEqual([attachment]);
    expect(fetcher.mock.calls[0][0]).toBe('https://api.nuberea.com/v1/chat');
  });

  it('rejects invalid attachment metadata, encoding and measurable byte limits before credential work', async () => {
    const getToken = vi.fn().mockResolvedValue('fixture');
    const client = new ChatClient(getToken);
    const attachment: ChatAttachment = { name: 'notes.txt', mediaType: 'text/plain', contentBase64: 'YQ==' };
    const tooLargePdf = Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64');
    const aggregateFile = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
    const libraryAttachment = { ...attachment, referenceId: 'not-a-library-file' };
    const invalid: ChatAttachment[][] = [
      Array.from({ length: 6 }, () => attachment),
      [{ ...attachment, name: '../notes.txt' }],
      [{ ...attachment, name: ' notes.txt' }],
      [{ ...attachment, contentBase64: 'AB==' }],
      [{ ...attachment, mediaType: 'application/pdf', contentBase64: tooLargePdf }],
      Array.from({ length: 2 }, () => ({ ...attachment, contentBase64: aggregateFile })),
      [libraryAttachment],
    ];
    for (const attachments of invalid) {
      await expect(client.send({ ...request, attachments })).rejects.toMatchObject({ code: 'INVALID_CHAT_PAYLOAD' });
    }
    await expect(client.send({ ...request, userMessage: 'x'.repeat(15 * 1024 * 1024) }))
      .rejects.toThrow('15 MiB');
    await expect(Reflect.apply(client.send, client, [{ ...request, conversationId: '12345678-1234-4234-8234-123456789012' }]))
      .rejects.toBeInstanceOf(ChatError);
    expect(getToken).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed skill metadata', frame('reasoning_skills', [{ instructionId: 'reasoning.claims_evidence', title: 'Claims' }]), /Invalid reasoning skills/],
    ['malformed chunk', frame('message', { chunk: 42 }), /Invalid chunk/],
    ['malformed final answer', frame('done', { message: 'Partial' }), /Invalid chat response/],
    ['invalid JSON', 'event: done\ndata: not-json\n\n', /Invalid JSON/],
    ['missing done', frame('message', { chunk: 'Partial' }), /without a done event/],
  ])('rejects %s even when no callbacks are registered', async (_name, text, error) => {
    const client = new ChatClient(async () => 'fixture', undefined, async () => stream(text));
    await expect(client.send(request)).rejects.toThrow(error);
  });

  it('rejects API errors with their code and status instead of returning partial text or retrying', async () => {
    const error = { code: 'RATE_LIMITED', message: 'Try later', details: ['Daily limit'] };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(error), { status: 429 }));
    await expect(new ChatClient(async () => 'fixture', undefined, fetcher).send(request)).rejects
      .toMatchObject({ name: 'ChatError', code: error.code, status: 429, details: error.details });
    expect(fetcher).toHaveBeenCalledOnce();
    const onEvent = vi.fn();
    const client = new ChatClient(async () => 'fixture', undefined,
      async () => stream(frame('message', { chunk: 'Partial' }) + frame('error', error)));
    await expect(client.send(request, { onEvent })).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 200 });
    expect(onEvent).toHaveBeenLastCalledWith('error', error);
  });

  it('surfaces non-JSON HTTP failures and successful non-SSE responses explicitly', async () => {
    await expect(new ChatClient(async () => 'fixture', undefined,
      async () => new Response('Service unavailable', { status: 503 })).send(request)).rejects
      .toMatchObject({ status: 503, message: 'Chat request failed (503): Service unavailable' });
    await expect(new ChatClient(async () => 'fixture', undefined,
      async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })).send(request)).rejects
      .toMatchObject({ code: 'INVALID_CHAT_STREAM' });
  });

  it('validates input and cancellation before credential work, and rejects missing Firebase credentials', async () => {
    const getToken = vi.fn().mockResolvedValue('');
    const client = new ChatClient(getToken);
    await expect(client.send({ ...request, userMessage: '' })).rejects.toBeInstanceOf(ChatError);
    const controller = new AbortController();
    controller.abort();
    await expect(client.send(request, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(getToken).not.toHaveBeenCalled();
    await expect(client.send(request)).rejects.toMatchObject({ code: 'CHAT_AUTH_REQUIRED' });
  });

  it('passes the abort signal to fetch and cancels the response body when a consumer callback fails', async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    const fetcher = vi.fn().mockImplementation(async (_url, init) => {
      expect(init.signal).toBe(controller.signal);
      return stream(frame('message', { chunk: 'Partial' }) + frame('done', answer), 100, cancelled);
    });
    const callbackError = new Error('Consumer stopped');
    await expect(new ChatClient(async () => 'fixture', undefined, fetcher).send(request, {
      signal: controller.signal, onChunk: () => { throw callbackError; },
    })).rejects.toBe(callbackError);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('allows explicit loopback testing but rejects insecure or credential-bearing remote bases', async () => {
    const fetcher = vi.fn().mockImplementation(async () => stream(frame('done', answer)));
    await new ChatClient(async () => 'fixture', 'http://127.0.0.1:8000/v1/', fetcher).send(request);
    expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:8000/v1/chat');
    for (const base of ['http://example.test/v1', 'https://user:pass@example.test/v1',
      'https://example.test/v1?token=bad', 'https://example.test/v1#fragment']) {
      expect(() => new ChatClient(async () => 'fixture', base)).toThrow('HTTPS API base');
    }
  });

  it('lets the CLI send normal chat using only a Firebase credential and print final skill metadata', async () => {
    let calls = 0;
    const server = createServer((incoming, outgoing) => {
      calls++;
      expect(incoming.url).toBe('/v1/chat');
      expect(incoming.headers.authorization).toBe('Bearer cli-firebase');
      outgoing.writeHead(200, { 'Content-Type': 'text/event-stream' });
      outgoing.end(frame('reasoning_skills', skills) + frame('message', { chunk: answer.message }) + frame('done', answer));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing CLI fixture port');
      const execute = promisify(execFile);
      const command = [
        '--import', 'tsx', fileURLToPath(new URL('./cli/index.ts', import.meta.url)),
        'chat', JSON.stringify(request), '--json',
      ];
      const options = {
        timeout: 10000,
        env: { ...process.env, NUBEREA_FIREBASE_ID_TOKEN: 'cli-firebase',
          NUBEREA_CHAT_URL: `http://127.0.0.1:${address.port}/v1`,
          NUBEREA_ACCESS_TOKEN: undefined },
      };
      const { stdout } = await execute(process.execPath, command, options);
      expect(JSON.parse(stdout)).toEqual(answer);
      expect(calls).toBe(1);
      command[4] = JSON.stringify({ ...request, userMessage: '' });
      await expect(execute(process.execPath, command, options)).rejects.toMatchObject({ code: 1 });
      expect(calls).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
