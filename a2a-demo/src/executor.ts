import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '@a2a-js/sdk';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { extractVellumSocial, makeResponsePart, makeWorkingPart } from './extension.js';
import type { VellumSocialRequestData } from './types.js';

export interface PeerConfig {
  name: string;
  responseText: string;
  strategy: 'standing_preference' | 'hitl_confirm' | 'hitl_stale_infer' | 'hitl_unreachable';
  humanDelayMs: number;
}

export class VellumSocialExecutor implements AgentExecutor {
  constructor(private readonly config: PeerConfig) {}

  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    // Extract Vellum extension data from user message parts
    const socialData = extractVellumSocial(context.userMessage.parts);

    if (!socialData) {
      const failedStatus: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId: context.taskId,
        contextId: context.contextId,
        status: {
          state: 'failed',
          message: {
            kind: 'message',
            messageId: crypto.randomUUID(),
            role: 'agent',
            parts: [{ kind: 'text', text: 'Missing x-vellum-social-v1 extension data' }],
          },
        },
        final: true,
      };
      eventBus.publish(failedStatus);
      eventBus.finished();
      return;
    }

    // TODO: enforce scope
    console.log('scope check: pass');

    const requestData = socialData as VellumSocialRequestData;
    const correlationId = requestData.correlation_id;

    switch (this.config.strategy) {
      case 'standing_preference':
        await this.executeStandingPreference(context, eventBus, correlationId);
        break;
      case 'hitl_confirm':
        await this.executeHitlConfirm(context, eventBus, correlationId);
        break;
      case 'hitl_stale_infer':
        await this.executeHitlStaleInfer(context, eventBus, correlationId);
        break;
      case 'hitl_unreachable':
        await this.executeHitlUnreachable(context, eventBus, correlationId);
        break;
    }
  }

  async cancelTask(_taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    eventBus.finished();
  }

  private async executeStandingPreference(
    context: RequestContext,
    eventBus: ExecutionEventBus,
    correlationId: string,
  ): Promise<void> {
    const artifactEvent: TaskArtifactUpdateEvent = {
      kind: 'artifact-update',
      taskId: context.taskId,
      contextId: context.contextId,
      artifact: {
        artifactId: crypto.randomUUID(),
        parts: [
          { kind: 'text', text: this.config.responseText },
          makeResponsePart({ response_basis: 'standing_preference', correlation_id: correlationId }),
        ],
      },
    };
    eventBus.publish(artifactEvent);

    const completedStatus: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: context.taskId,
      contextId: context.contextId,
      status: { state: 'completed' },
      final: true,
    };
    eventBus.publish(completedStatus);

    eventBus.finished();
  }

  private async executeHitlConfirm(
    context: RequestContext,
    eventBus: ExecutionEventBus,
    correlationId: string,
  ): Promise<void> {
    const workingStatus: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: context.taskId,
      contextId: context.contextId,
      status: {
        state: 'working',
        message: {
          kind: 'message',
          messageId: crypto.randomUUID(),
          role: 'agent',
          parts: [makeWorkingPart({ hitl_state: 'awaiting_human_input', correlation_id: correlationId })],
        },
      },
      final: false,
    };
    eventBus.publish(workingStatus);

    await Bun.sleep(this.config.humanDelayMs);

    const artifactEvent: TaskArtifactUpdateEvent = {
      kind: 'artifact-update',
      taskId: context.taskId,
      contextId: context.contextId,
      artifact: {
        artifactId: crypto.randomUUID(),
        parts: [
          { kind: 'text', text: this.config.responseText },
          makeResponsePart({ response_basis: 'confirmed', correlation_id: correlationId }),
        ],
      },
    };
    eventBus.publish(artifactEvent);

    const completedStatus: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: context.taskId,
      contextId: context.contextId,
      status: { state: 'completed' },
      final: true,
    };
    eventBus.publish(completedStatus);

    eventBus.finished();
  }

  private async executeHitlStaleInfer(
    context: RequestContext,
    eventBus: ExecutionEventBus,
    correlationId: string,
  ): Promise<void> {
    // First working status: awaiting_human_input
    const workingStatus1: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: context.taskId,
      contextId: context.contextId,
      status: {
        state: 'working',
        message: {
          kind: 'message',
          messageId: crypto.randomUUID(),
          role: 'agent',
          parts: [makeWorkingPart({ hitl_state: 'awaiting_human_input', correlation_id: correlationId })],
        },
      },
      final: false,
    };
    eventBus.publish(workingStatus1);

    await Bun.sleep(this.config.humanDelayMs);

    // Second working status: awaiting_human_input_stale
    const workingStatus2: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: context.taskId,
      contextId: context.contextId,
      status: {
        state: 'working',
        message: {
          kind: 'message',
          messageId: crypto.randomUUID(),
          role: 'agent',
          parts: [makeWorkingPart({ hitl_state: 'awaiting_human_input_stale', correlation_id: correlationId })],
        },
      },
      final: false,
    };
    eventBus.publish(workingStatus2);

    await Bun.sleep(this.config.humanDelayMs);

    const artifactEvent: TaskArtifactUpdateEvent = {
      kind: 'artifact-update',
      taskId: context.taskId,
      contextId: context.contextId,
      artifact: {
        artifactId: crypto.randomUUID(),
        parts: [
          { kind: 'text', text: this.config.responseText },
          makeResponsePart({ response_basis: 'inferred', correlation_id: correlationId }),
        ],
      },
    };
    eventBus.publish(artifactEvent);

    const completedStatus: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: context.taskId,
      contextId: context.contextId,
      status: { state: 'completed' },
      final: true,
    };
    eventBus.publish(completedStatus);

    eventBus.finished();
  }

  private async executeHitlUnreachable(
    context: RequestContext,
    eventBus: ExecutionEventBus,
    correlationId: string,
  ): Promise<void> {
    const workingStatus: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: context.taskId,
      contextId: context.contextId,
      status: {
        state: 'working',
        message: {
          kind: 'message',
          messageId: crypto.randomUUID(),
          role: 'agent',
          parts: [makeWorkingPart({ hitl_state: 'awaiting_human_input', correlation_id: correlationId })],
        },
      },
      final: false,
    };
    eventBus.publish(workingStatus);

    await Bun.sleep(this.config.humanDelayMs);

    const artifactEvent: TaskArtifactUpdateEvent = {
      kind: 'artifact-update',
      taskId: context.taskId,
      contextId: context.contextId,
      artifact: {
        artifactId: crypto.randomUUID(),
        parts: [
          { kind: 'text', text: this.config.responseText },
          makeResponsePart({ response_basis: 'unreachable', correlation_id: correlationId }),
        ],
      },
    };
    eventBus.publish(artifactEvent);

    const completedStatus: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: context.taskId,
      contextId: context.contextId,
      status: { state: 'completed' },
      final: true,
    };
    eventBus.publish(completedStatus);

    eventBus.finished();
  }
}
