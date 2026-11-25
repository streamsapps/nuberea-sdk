import { afterEach, describe, expect, it, vi } from 'vitest';
import { NuBerea } from './client.js';
import { AgentClient, type AgentPlan } from './agent.js';

const request = { gptModel: '5.6 terra' as const, userMessage: 'Assess the supplied evidence.', enabledCollections: [] };
const plan: AgentPlan = {
  summary: 'Assess the evidence.', assumptions: [], steps: [{
    id: 'step-1', title: 'Clarify the task', rationale: 'Scope is needed.',
    intendedTools: [], expectedSources: [], optional: false, needsUserInput: true, inputPrompt: 'Which period?',
  }],
};
const result = {
  plan, responseID: 'resp_plan', needsUserInput: true,
  inputRequests: [{ stepId: 'step-1', title: 'Clarify the task', inputPrompt: 'Which period?' }], sources: [],
};
const frame = (event: string, data: unknown) => `${event === 'message' ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
const response = (text: string) => new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('read-only agent SDK', () => {
  it('streams planning, plan and needs-input events and preserves the complete final plan, including null private response IDs', async () => {
    const lifecycle: string[] = [];
    const final = { ...result, responseID: null };
    const client = new AgentClient(async () => 'firebase', undefined, async (_url, init) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer firebase');
      return response(frame('thinking', { message: 'Planning...' }) + frame('plan', final)
        + frame('needs_input', { inputRequests: final.inputRequests, responseID: null }) + frame('done', final));
    });
    expect(await client.plan(request, {
      onThinking: () => lifecycle.push('thinking'),
      onPlan: (value) => { lifecycle.push('plan'); expect(value).toEqual(final); },
      onNeedsInput: (value) => { lifecycle.push('input'); expect(value.responseID).toBeNull(); },
    })).toEqual(final);
    expect(lifecycle).toEqual(['thinking', 'plan', 'input']);
  });

  it('sends an approved plan to agent/run, forwards step/tool/text activity and returns the actual final response', async () => {
    const fetcher = vi.fn().mockImplementation(async () => response(
      frame('step', { stepId: 'step-1', status: 'in_progress', matchedToolName: 'tenant_tool' })
      + frame('tool_call', { toolName: 'tenant_tool', arguments: {}, output: 'Evidence', status: 'success' })
      + frame('message', { chunk: 'Answer' })
      + frame('done', { message: 'Answer', responseID: 'resp_run', isVerified: true })));
    vi.stubGlobal('fetch', fetcher);
    const client = new NuBerea({ accessToken: 'oauth-not-firebase', firebaseIdToken: 'firebase' });
    const onStep = vi.fn(), onChunk = vi.fn(), onToolCall = vi.fn();
    const output = await client.agent.run({ ...request, plan, maxTurns: 4 }, { onStep, onChunk, onToolCall });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.nuberea.com/v1/agent/run');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ ...request, plan, maxTurns: 4 });
    expect(onStep).toHaveBeenCalledWith({ stepId: 'step-1', status: 'in_progress', matchedToolName: 'tenant_tool' });
    expect(onChunk).toHaveBeenCalledWith('Answer');
    expect(onToolCall).toHaveBeenCalledOnce();
    expect(output.message).toBe('Answer');
  });

  it('rejects managed conversation and unknown request fields before any credential or network work', async () => {
    const token = vi.fn().mockResolvedValue('firebase'), fetcher = vi.fn();
    const client = new AgentClient(token, undefined, fetcher);
    for (const method of [client.send, client.plan, client.run]) {
      await expect(Reflect.apply(method, client, [{ ...request, conversationId: '12345678-1234-4234-8234-123456789012' }]))
        .rejects.toMatchObject({ code: 'INVALID_CHAT_PAYLOAD' });
      await expect(Reflect.apply(method, client, [{ ...request, storeConversation: true }])).rejects.toThrow('Invalid');
    }
    expect(token).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails malformed planning/step events without callbacks and enforces required-input plan semantics', async () => {
    await expect(new AgentClient(async () => 'firebase', undefined,
      async () => response(frame('thinking', { message: 7 }))).plan(request)).rejects.toThrow('planning activity');
    await expect(new AgentClient(async () => 'firebase', undefined,
      async () => response(frame('step', { status: 'completed' }))).run(request)).rejects.toThrow('step update');
    await expect(new AgentClient(async () => 'firebase').run({
      ...request, plan: { ...plan, steps: [{ ...plan.steps[0], inputPrompt: '' }] },
    })).rejects.toThrow('inputPrompt');
  });
});
