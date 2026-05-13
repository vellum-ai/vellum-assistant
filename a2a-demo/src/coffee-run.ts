import type { Artifact, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { ClientFactory, ClientFactoryOptions } from '@a2a-js/sdk/client';
import { VellumSocialInterceptor } from './interceptor.js';
import { extractVellumSocial } from './extension.js';
import type { Connection, ConnectionsConfig, VellumSocialResponseData } from './types.js';
import type { EventBus } from './events.js';

import connectionsJson from './connections.json' with { type: 'json' };

interface CoffeeRunOptions {
  deadlineSeconds?: number;
  eventBus: EventBus;
  connections?: Connection[];
}

/**
 * Orchestrate a coffee run: fan out A2A requests to all connected peers in parallel,
 * collect responses via streaming, and broadcast SSE events for the demo UI.
 */
export async function runCoffeeScenario(options: CoffeeRunOptions): Promise<void> {
  const { eventBus, deadlineSeconds = 15 } = options;
  const correlationId = crypto.randomUUID();
  const deadline = new Date(Date.now() + deadlineSeconds * 1000).toISOString();

  const connections = options.connections ?? (connectionsJson as ConnectionsConfig).connections;

  // Fan out to all peers in parallel
  const results = await Promise.allSettled(
    connections.map(async (conn) => {
      // Create a ClientFactory with the interceptor configured upfront
      const interceptor = new VellumSocialInterceptor(() => ({
        connection_id: conn.id,
        sender_relationship: conn.declared_relationship,
        correlation_id: correlationId,
        deadline,
      }));
      const factory = new ClientFactory(
        ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
          clientConfig: { interceptors: [interceptor] },
        }),
      );

      let client;
      try {
        client = await factory.createFromUrl(conn.peer_base_url);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        eventBus.broadcast('task_error', {
          peer: conn.peer_assistant_id,
          taskId: null,
          error: `Failed to discover agent card: ${message}`,
        });
        return;
      }

      // Check for x-vellum-social-v1 support on the resolved agent card
      const agentCard = await client.getAgentCard() as unknown as Record<string, unknown>;
      if (!agentCard['x-vellum-social-v1']) {
        console.warn(`Peer ${conn.peer_assistant_id} does not support x-vellum-social-v1, skipping`);
        eventBus.broadcast('task_error', {
          peer: conn.peer_assistant_id,
          taskId: null,
          error: 'peer does not support x-vellum-social-v1',
        });
        return;
      }

      // Cache the latest artifact per peer — needed because `completed` status
      // does NOT carry the artifact
      const artifactCache = new Map<string, Artifact>();

      const messageId = crypto.randomUUID();

      // Broadcast task_sent immediately — taskId is null because the SDK
      // assigns it server-side; we don't know it until the first stream event
      eventBus.broadcast('task_sent', {
        peer: conn.peer_assistant_id,
        messageId,
        correlationId,
        taskId: null,
        method: 'message/stream',
      });

      try {
        const stream = client.sendMessageStream({
          message: {
            kind: 'message',
            messageId,
            role: 'user',
            parts: [{ kind: 'text', text: 'Coffee run! What would you like?' }],
          },
        });

        let firstEvent = true;

        for await (const event of stream) {
          // On the first stream event, extract the taskId
          if (firstEvent) {
            firstEvent = false;
            const e = event as unknown as Record<string, unknown>;
            const taskId = e.taskId ?? e.id ?? null;
            if (taskId) {
              eventBus.broadcast('protocol_event', {
                peer: conn.peer_assistant_id,
                eventType: 'task_assigned',
                taskId,
                sdkEvent: prettifyEvent(event),
              });
            }
          }

          // Always broadcast protocol_event with the raw prettified SDK event
          const eventRecord = event as unknown as Record<string, unknown>;
          eventBus.broadcast('protocol_event', {
            peer: conn.peer_assistant_id,
            eventType: event.kind,
            taskId: eventRecord.taskId ?? null,
            sdkEvent: prettifyEvent(event),
          });

          // Handle TaskArtifactUpdateEvent — cache the artifact
          if (event.kind === 'artifact-update') {
            const artifactEvent = event as TaskArtifactUpdateEvent;
            artifactCache.set(artifactEvent.artifact.artifactId, artifactEvent.artifact);
          }

          // Handle TaskStatusUpdateEvent
          if (event.kind === 'status-update') {
            const statusEvent = event as TaskStatusUpdateEvent;

            if (statusEvent.status.state === 'working' && statusEvent.status.message) {
              // Extract HITL DataPart from working status message
              const socialData = extractVellumSocial(statusEvent.status.message.parts);
              eventBus.broadcast('hitl_update', {
                peer: conn.peer_assistant_id,
                taskId: statusEvent.taskId,
                hitlState: socialData && 'hitl_state' in socialData ? socialData.hitl_state : null,
                sdkEvent: prettifyEvent(event),
              });
            }

            if (statusEvent.status.state === 'completed') {
              // Read artifact from cache (not from the status event)
              const cachedArtifact = [...artifactCache.values()].pop();
              let responseText: string | null = null;
              let responseBasis: string | null = null;

              if (cachedArtifact) {
                // Extract responseText from TextPart
                const textPart = cachedArtifact.parts.find((p) => p.kind === 'text');
                if (textPart && textPart.kind === 'text') {
                  responseText = (textPart as { kind: 'text'; text: string }).text;
                }

                // Extract responseBasis from response DataPart
                const socialData = extractVellumSocial(cachedArtifact.parts);
                if (socialData && 'response_basis' in socialData) {
                  responseBasis = (socialData as VellumSocialResponseData).response_basis;
                }
              }

              eventBus.broadcast('task_completed', {
                peer: conn.peer_assistant_id,
                taskId: statusEvent.taskId,
                responseText,
                responseBasis,
                sdkEvent: prettifyEvent(event),
              });
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        eventBus.broadcast('task_error', {
          peer: conn.peer_assistant_id,
          taskId: null,
          error: message,
        });
      }
    }),
  );

  // Log any unhandled rejections (shouldn't happen with allSettled, but be safe)
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('Unexpected rejection in coffee run:', result.reason);
    }
  }

  eventBus.broadcast('run_complete', { correlationId });
}

/**
 * Create a prettified representation of an SDK event for protocol logging.
 */
function prettifyEvent(event: unknown): Record<string, unknown> {
  const e = event as Record<string, unknown>;
  return {
    kind: e.kind,
    ...(e.taskId != null ? { taskId: e.taskId } : {}),
    ...(e.contextId != null ? { contextId: e.contextId } : {}),
    ...(e.status != null ? { status: e.status } : {}),
    ...(e.artifact != null ? { artifact: e.artifact } : {}),
    ...(e.role != null ? { role: e.role } : {}),
    ...(e.parts != null ? { parts: e.parts } : {}),
    ...(e.final != null ? { final: e.final } : {}),
  };
}
