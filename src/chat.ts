import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const choices = <T extends string>(...values: T[]) => Type.Union(values.map((value) => Type.Literal(value)));
const optionalNullable = <T extends TSchema>(schema: T) => Type.Optional(Type.Union([schema, Type.Null()]));

export const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_CHAT_PDF_BYTES = 4 * 1024 * 1024;
export const MAX_CHAT_BODY_BYTES = 15 * 1024 * 1024;

export const ChatAttachmentSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255, pattern: '^[^/\\\\\\x00-\\x1f\\x7f-\\x9f]+$' }),
  mediaType: choices('application/pdf', 'text/plain', 'text/markdown', 'application/json',
    'text/csv', 'text/tab-separated-values'),
  contentBase64: Type.String({
    minLength: 4, maxLength: Math.ceil(MAX_CHAT_ATTACHMENT_BYTES / 3) * 4, pattern: '^[A-Za-z0-9+/]*={0,2}$',
  }),
}, { additionalProperties: false });
export type ChatAttachment = Static<typeof ChatAttachmentSchema>;

export const ScriptureReaderTargetSchema = Type.Object({
  translationId: Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,31}$' }),
  bookKey: Type.String({ minLength: 1, maxLength: 160 }),
  chapter: Type.String({ pattern: '^[1-9][0-9]{0,2}$' }),
  verseStart: Type.Optional(Type.String({ pattern: '^(0|[1-9][0-9]{0,2})[a-zA-Z]?$' })),
  verseEnd: Type.Optional(Type.String({ pattern: '^(0|[1-9][0-9]{0,2})[a-zA-Z]?$' })),
}, { additionalProperties: false });
export type ScriptureReaderTarget = Static<typeof ScriptureReaderTargetSchema>;

export const ChatRequestSchema = Type.Object({
  gptModel: choices('4o', 'o3', '4.1', '4.1 mini', '4.1 nano', '4o mini', '4 nano', '5 nano', '5 mini',
    '5', '5.1', '5.2', '5.5', '5.6', '5.6 luna', '5.6 terra', '5.6 sol', '6 luna', '6.1 sol'),
  userMessage: Type.String({ minLength: 1 }),
  previous_response_id: optionalNullable(Type.String()),
  conversationId: Type.Optional(Type.String({
    pattern: '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',
  })),
  enabledCollections: optionalNullable(Type.Array(Type.String())),
  workflowMode: optionalNullable(choices('read', 'compare', 'parse', 'variants', 'witnesses', 'dss',
    'redaction', 'theme_trace', 'translation')),
  reasoning: optionalNullable(Type.Object({
    effort: optionalNullable(choices('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra')),
    mode: optionalNullable(Type.Literal('pro')),
  })),
  responseFormat: Type.Optional(choices('markdown', 'nuberea-rich')),
  passageContext: optionalNullable(Type.Object({
    reference: Type.String(),
    translation: Type.String(),
    selectedText: Type.String(),
    selectionKind: choices('verse', 'footnote'),
    readerTarget: Type.Optional(ScriptureReaderTargetSchema),
    footnoteRef: Type.Optional(Type.String()),
    footnoteText: Type.Optional(Type.String()),
  })),
  attachments: Type.Optional(Type.Array(ChatAttachmentSchema, { maxItems: 5 })),
  libraryFileIds: Type.Optional(Type.Never()),
});
export type ChatRequest = Static<typeof ChatRequestSchema>;

export const ReasoningSkillUsageSchema = Type.Object({
  instructionId: Type.String({ minLength: 1 }),
  version: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
});
export type ReasoningSkillUsage = Static<typeof ReasoningSkillUsageSchema>;

export const ToolCallRecordSchema = Type.Object({
  toolName: Type.String(),
  arguments: Type.Record(Type.String(), Type.Unknown()),
  output: Type.String(),
  status: choices('in_progress', 'success', 'error'),
  errorMessage: Type.Optional(Type.String()),
  durationMs: Type.Optional(Type.Number()),
  toolCallId: Type.Optional(Type.String()),
});
export type ToolCallRecord = Static<typeof ToolCallRecordSchema>;

export const ChatResponseSchema = Type.Object({
  message: Type.String(),
  responseID: Type.String(),
  isVerified: Type.Boolean(),
  sources: Type.Optional(Type.Array(Type.Object({
    collectionId: Type.String(), label: Type.String(), shortLabel: Type.String(),
    kind: choices('text', 'morphology', 'lexicon', 'manuscript', 'parallel', 'graph', 'analytics', 'web', 'file'),
    toolName: Type.Optional(Type.String()), url: Type.Optional(Type.String()), title: Type.Optional(Type.String()),
    sha256: Type.Optional(Type.String()), mediaType: Type.Optional(Type.String()),
  }))),
  annotations: Type.Optional(Type.Array(Type.Object({
    type: Type.Literal('url_citation'), url: Type.String(), title: Type.Optional(Type.String()),
    startIndex: Type.Optional(Type.Number()), endIndex: Type.Optional(Type.Number()),
  }))),
  answerKind: Type.Optional(choices('standard', 'variants')),
  workflowMode: optionalNullable(Type.String()),
  workflowLabel: optionalNullable(Type.String()),
  reasoningSkills: Type.Optional(Type.Array(ReasoningSkillUsageSchema)),
  referenceActions: Type.Optional(Type.Array(Type.Object({
    label: Type.String(), bookId: Type.String(), osisId: Type.Optional(Type.String()), chapter: Type.String(),
    verseStart: Type.Optional(Type.String()), verseEnd: Type.Optional(Type.String()),
    readerTarget: Type.Optional(ScriptureReaderTargetSchema),
  }))),
  referenceActionMode: Type.Optional(choices('none', 'open_only', 'compare_and_open', 'compare_only')),
  toolCalls: Type.Optional(Type.Array(ToolCallRecordSchema)),
  usage: Type.Optional(Type.Object({
    contextTokens: Type.Number(), inputTokens: Type.Number(), cachedInputTokens: Type.Number(),
    outputTokens: Type.Number(), reasoningTokens: Type.Number(), totalTokens: Type.Number(),
    contextLimit: Type.Optional(Type.Number()), limitKind: Type.Optional(choices('compaction', 'model')),
  })),
});
export type ChatResponse = Static<typeof ChatResponseSchema>;

const ThinkingSchema = Type.Object({ idleMs: Type.Number(), elapsedMs: Type.Number(), message: Type.String() });
export type ChatThinking = Static<typeof ThinkingSchema>;
const ErrorSchema = Type.Object({
  code: Type.String(), message: Type.String(), details: Type.Optional(Type.Array(Type.String())),
});

export interface ChatOptions {
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
  onReasoningSkills?: (skills: ReasoningSkillUsage[]) => void;
  onToolCallStart?: (tool: ToolCallRecord) => void;
  onToolCall?: (tool: ToolCallRecord) => void;
  onThinking?: (thinking: ChatThinking) => void;
  /** Receives every JSON event, including future event types. Unnamed chunks use "message". */
  onEvent?: (event: string, data: unknown) => void;
}

export class ChatError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number, readonly details?: unknown) {
    super(message);
    this.name = 'ChatError';
  }
}

function validate<T extends TSchema>(schema: T, value: unknown, label: string): Static<T> {
  if (!Value.Check(schema, value)) {
    const error = Value.Errors(schema, value).First();
    throw new ChatError(`Invalid ${label}: ${error?.path} ${error?.message}`, 'INVALID_CHAT_PAYLOAD');
  }
  return value;
}

export function resolveChatBaseUrl(oauthBaseUrl: string): string {
  const url = new URL(oauthBaseUrl);
  if (url.hostname === 'auth.nuberea.com' || url.hostname === 'api.nuberea.com') return 'https://api.nuberea.com/v1';
  if (url.hostname === 'auth.nubereappe.com' || url.hostname === 'api.nubereappe.com') return 'https://api.nubereappe.com/v1';
  return oauthBaseUrl.replace(/\/+$/, '') + '/v1';
}

export class ChatClient {
  private readonly endpoint: string;

  constructor(
    private readonly getFirebaseIdToken: () => Promise<string>,
    base = 'https://api.nuberea.com/v1',
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const url = new URL(base);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || url.username || url.password || url.search || url.hash) {
      throw new ChatError('Chat requires a credential-free HTTPS API base (HTTP is allowed only on loopback)');
    }
    this.endpoint = base.replace(/\/+$/, '') + '/chat';
  }

  async send(request: ChatRequest, options: ChatOptions = {}): Promise<ChatResponse> {
    validate(ChatRequestSchema, request, 'chat request');
    options.signal?.throwIfAborted();
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body, 'utf8') > MAX_CHAT_BODY_BYTES) {
      throw new ChatError('Chat request exceeds the 15 MiB JSON body limit', 'INVALID_CHAT_PAYLOAD');
    }
    let totalAttachmentBytes = 0;
    for (const attachment of request.attachments ?? []) {
      if (attachment.name !== attachment.name.trim()) {
        throw new ChatError('Attachment names must not have leading or trailing whitespace', 'INVALID_CHAT_PAYLOAD');
      }
      const content = attachment.contentBase64;
      const bytes = Buffer.from(content, 'base64');
      if (content.length % 4 !== 0 || bytes.toString('base64') !== content) {
        throw new ChatError('Attachment content must be canonical padded base64', 'INVALID_CHAT_PAYLOAD');
      }
      const maximum = attachment.mediaType === 'application/pdf' ? MAX_CHAT_PDF_BYTES : MAX_CHAT_ATTACHMENT_BYTES;
      if (bytes.length > maximum) {
        throw new ChatError('Attachment exceeds its decoded byte limit (PDF: 4 MiB; other files: 10 MiB)', 'INVALID_CHAT_PAYLOAD');
      }
      totalAttachmentBytes += bytes.length;
    }
    if (totalAttachmentBytes > MAX_CHAT_ATTACHMENT_BYTES) {
      throw new ChatError('Attachments exceed the aggregate decoded 10 MiB limit', 'INVALID_CHAT_PAYLOAD');
    }
    const token = await this.getFirebaseIdToken();
    if (!token) throw new ChatError('A Firebase ID token is required for chat', 'CHAT_AUTH_REQUIRED');
    options.signal?.throwIfAborted();
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body,
      redirect: 'error',
      signal: options.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      let data: unknown;
      try { data = JSON.parse(text); } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new ChatError(`Chat request failed (${response.status}): ${text || response.statusText}`, undefined, response.status);
      }
      const payload = typeof data === 'object' && data !== null ? data : {};
      throw new ChatError(
        'message' in payload && typeof payload.message === 'string' ? payload.message : `Chat request failed (${response.status})`,
        'code' in payload && typeof payload.code === 'string' ? payload.code : undefined,
        response.status,
        'details' in payload ? payload.details : undefined,
      );
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) {
      throw new ChatError('Expected a chat SSE response', 'INVALID_CHAT_STREAM');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    const dispatch = (frame: string): ChatResponse | undefined => {
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        if (field === 'data') dataLines.push(value);
      }
      if (!dataLines.length) return;
      let data: unknown;
      try { data = JSON.parse(dataLines.join('\n')); } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new ChatError(`Invalid JSON in chat ${event} event`, 'INVALID_CHAT_STREAM');
      }
      let result: ChatResponse | undefined;
      switch (event) {
        case 'message': {
          const chunk = validate(Type.Object({ chunk: Type.String() }), data, 'chunk');
          options.onChunk?.(chunk.chunk);
          break;
        }
        case 'reasoning_skills': {
          const skills = validate(Type.Array(ReasoningSkillUsageSchema), data, 'reasoning skills');
          options.onReasoningSkills?.(skills);
          break;
        }
        case 'tool_call_start':
        case 'tool_call': {
          const tool = validate(ToolCallRecordSchema, data, 'tool call');
          if (event === 'tool_call_start') options.onToolCallStart?.(tool);
          else options.onToolCall?.(tool);
          break;
        }
        case 'thinking': {
          const thinking = validate(ThinkingSchema, data, 'thinking event');
          options.onThinking?.(thinking);
          break;
        }
        case 'done': result = validate(ChatResponseSchema, data, 'chat response'); break;
        case 'error': {
          const error = validate(ErrorSchema, data, 'chat error');
          options.onEvent?.(event, error);
          throw new ChatError(error.message, error.code, response.status, error.details);
        }
      }
      options.onEvent?.(event, data);
      return result;
    };

    try {
      while (true) {
        options.signal?.throwIfAborted();
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const result = dispatch(frame);
          if (result) return result;
        }
        if (done) {
          if (buffer) {
            const result = dispatch(buffer);
            if (result) return result;
          }
          throw new ChatError('Chat stream ended without a done event', 'INCOMPLETE_CHAT_STREAM');
        }
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
}
