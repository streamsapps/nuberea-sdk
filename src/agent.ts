import { Type, type Static } from '@sinclair/typebox';
import { ChatClient, ChatRequestSchema, ChatResponseSchema, ChatError, validateChatPayload, type ChatOptions } from './chat.js';

export const PlanStepSchema = Type.Object({
  id: Type.String(), title: Type.String(), rationale: Type.String(),
  intendedTools: Type.Array(Type.String()), expectedSources: Type.Array(Type.String()),
  optional: Type.Boolean(), needsUserInput: Type.Boolean(), inputPrompt: Type.String(),
});
export const PlanSchema = Type.Object({
  summary: Type.String(), assumptions: Type.Array(Type.String()), steps: Type.Array(PlanStepSchema, { minItems: 1 }),
});
export type AgentPlan = Static<typeof PlanSchema>;
export const PlanInputRequestSchema = Type.Object({
  stepId: Type.String(), title: Type.String(), inputPrompt: Type.String(),
});
export const AgentPlanResponseSchema = Type.Object({
  plan: PlanSchema, responseID: Type.Union([Type.String(), Type.Null()]),
  needsUserInput: Type.Boolean(), inputRequests: Type.Array(PlanInputRequestSchema),
  usage: ChatResponseSchema.properties.usage, sources: ChatResponseSchema.properties.sources,
});
export type AgentPlanResponse = Static<typeof AgentPlanResponseSchema>;
export const AgentNeedsInputSchema = Type.Pick(AgentPlanResponseSchema, ['inputRequests', 'responseID']);
export type AgentNeedsInput = Static<typeof AgentNeedsInputSchema>;
export const AgentStepUpdateSchema = Type.Object({
  stepId: Type.String(), status: Type.Union([Type.Literal('in_progress'), Type.Literal('completed')]),
  matchedToolName: Type.Optional(Type.String()),
});
export type AgentStepUpdate = Static<typeof AgentStepUpdateSchema>;
export const AgentPlanRequestSchema = Type.Pick(ChatRequestSchema, [
  'gptModel', 'userMessage', 'previous_response_id', 'enabledCollections', 'workflowMode', 'reasoning',
  'attachments', 'conversationId', 'libraryFileIds',
]);
export type AgentPlanRequest = Static<typeof AgentPlanRequestSchema>;
export const AgentRunRequestSchema = Type.Object({
  ...AgentPlanRequestSchema.properties,
  responseFormat: ChatRequestSchema.properties.responseFormat,
  plan: Type.Optional(Type.Union([PlanSchema, Type.Null()])),
  maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
}, { additionalProperties: false });
export type AgentRunRequest = Static<typeof AgentRunRequestSchema>;
export const PlanningThinkingSchema = Type.Object({ message: Type.String() });

export interface AgentPlanOptions {
  signal?: AbortSignal;
  onEvent?: ChatOptions['onEvent'];
  onThinking?: (thinking: Static<typeof PlanningThinkingSchema>) => void;
  onPlan?: (plan: AgentPlanResponse) => void;
  onNeedsInput?: (input: AgentNeedsInput) => void;
}
export interface AgentRunOptions extends ChatOptions {
  onStep?: (step: AgentStepUpdate) => void;
}

export class AgentClient extends ChatClient {
  async plan(request: AgentPlanRequest, options: AgentPlanOptions = {}): Promise<AgentPlanResponse> {
    return this.sendStream(request, AgentPlanRequestSchema, AgentPlanResponseSchema, '/agent/plan', options, (event, data) => {
      if (event === 'thinking') {
        const thinking = validateChatPayload(PlanningThinkingSchema, data, 'planning activity');
        options.onThinking?.(thinking);
      } else if (event === 'plan') {
        const plan = validateChatPayload(AgentPlanResponseSchema, data, 'agent plan');
        options.onPlan?.(plan);
      } else if (event === 'needs_input') {
        const input = validateChatPayload(AgentNeedsInputSchema, data, 'agent input requests');
        options.onNeedsInput?.(input);
      } else return false;
      return true;
    });
  }

  async run(request: AgentRunRequest, options: AgentRunOptions = {}): Promise<Static<typeof ChatResponseSchema>> {
    validateChatPayload(AgentRunRequestSchema, request, 'agent run request');
    for (const step of request.plan?.steps ?? []) {
      if (step.needsUserInput ? !step.inputPrompt.trim() : step.inputPrompt !== '') {
        throw new ChatError('Plan inputPrompt must be a question only when needsUserInput is true', 'INVALID_CHAT_PAYLOAD');
      }
    }
    return this.sendStream(request, AgentRunRequestSchema, ChatResponseSchema, '/agent/run', options, (event, data) => {
      if (event !== 'step') return false;
      const step = validateChatPayload(AgentStepUpdateSchema, data, 'agent step update');
      options.onStep?.(step);
      return true;
    });
  }
}
