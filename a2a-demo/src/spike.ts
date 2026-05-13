/**
 * SDK Spike — Minimal A2A server + client roundtrip to verify exact SDK import paths and API shapes.
 *
 * ===== VERIFIED SDK FINDINGS =====
 *
 * Import paths (all compile from @a2a-js/sdk v0.3.13):
 *   - Types (Part, DataPart, Message, AgentCard, etc.): `@a2a-js/sdk`
 *   - Server (AgentExecutor, RequestContext, ExecutionEventBus, DefaultRequestHandler,
 *     InMemoryTaskStore, DefaultExecutionEventBusManager): `@a2a-js/sdk/server`
 *   - Express handlers (agentCardHandler, jsonRpcHandler, UserBuilder): `@a2a-js/sdk/server/express`
 *   - Client (ClientFactory, ClientFactoryOptions): `@a2a-js/sdk/client`
 *   - Client interceptors (CallInterceptor, BeforeArgs): `@a2a-js/sdk/client`
 *
 * RequestContext:
 *   - Field is `.userMessage` (not `.message`)
 *   - Constructor: (userMessage, taskId, contextId, task?, referenceTasks?, context?)
 *   - `.task` is optional — undefined for first message of a new task
 *
 * ExecutionEventBus:
 *   - `.publish(event)` — publishes AgentExecutionEvent (Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent)
 *   - `.finished()` — REQUIRED. Signals end of execution. Without it the stream never closes.
 *
 * Message:
 *   - Requires `kind: 'message'` (discriminator field)
 *   - Requires `messageId: string` (UUID)
 *   - Requires `role: 'user' | 'agent'`
 *   - Requires `parts: Part[]`
 *
 * TaskStatusUpdateEvent:
 *   - `final: boolean` is REQUIRED (not optional). Must be `true` on the last status event.
 *   - Requires `kind: 'status-update'`, `taskId`, `contextId`, `status: { state }`
 *
 * TaskArtifactUpdateEvent:
 *   - Requires `kind: 'artifact-update'`, `taskId`, `contextId`, `artifact: { artifactId, parts }`
 *
 * BeforeArgs (interceptor):
 *   - `args.input.value` contains the MessageSendParams
 *   - For sendMessageStream: `args.input.value.message.parts` to access outgoing message parts
 *   - `args.input.method` is 'sendMessage' | 'sendMessageStream' | etc.
 *
 * ClientFactory:
 *   - Constructor takes optional ClientFactoryOptions
 *   - `ClientFactoryOptions.createFrom(ClientFactoryOptions.default, { clientConfig: { interceptors: [...] } })`
 *   - Interceptors go in `clientConfig.interceptors`, NOT registered post-construction
 *   - `.createFromUrl(baseUrl)` fetches agent card and creates client
 *
 * UserBuilder.noAuthentication:
 *   - Required for jsonRpcHandler options
 *   - `jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication })` — options object API
 *
 * agentCardHandler:
 *   - Takes `{ agentCardProvider }` — can be a requestHandler or an async lambda `() => Promise<AgentCard>`
 *
 * DefaultRequestHandler constructor:
 *   - (agentCard, taskStore, agentExecutor, eventBusManager?, ...)
 *   - eventBusManager is optional — if not provided, uses its own internal default
 *
 * ===== END FINDINGS =====
 */

import type {
  AgentCard,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  Message,
} from '@a2a-js/sdk';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { ClientFactory, ClientFactoryOptions } from '@a2a-js/sdk/client';
import express from 'express';

/**
 * Trivial executor that echoes incoming text back as an artifact, then completes.
 */
const echoExecutor: AgentExecutor = {
  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    // Extract text from the user message
    const userText = requestContext.userMessage.parts
      .filter((p): p is { kind: 'text'; text: string; metadata?: Record<string, unknown> } => p.kind === 'text')
      .map((p) => p.text)
      .join(' ');

    // Publish an artifact with the echoed text
    const artifactEvent: TaskArtifactUpdateEvent = {
      kind: 'artifact-update',
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
      artifact: {
        artifactId: 'echo-artifact-1',
        name: 'echo',
        parts: [{ kind: 'text', text: `echo: ${userText}` }],
      },
    };
    eventBus.publish(artifactEvent);

    // Publish completed status with final: true
    const statusEvent: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
      status: { state: 'completed' },
      final: true,
    };
    eventBus.publish(statusEvent);

    // Signal the event bus that execution is done — REQUIRED or the stream never closes
    eventBus.finished();
  },

  async cancelTask(_taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    eventBus.finished();
  },
};

/**
 * Creates and starts a minimal A2A server on the given port.
 * Returns the HTTP server instance for cleanup.
 */
export function createSpikeServer(port: number) {
  const agentCard: AgentCard = {
    name: 'Spike Echo Agent',
    url: `http://localhost:${port}/a2a/jsonrpc`,
    description: 'A trivial echo agent for SDK spike testing',
    protocolVersion: '0.2.0',
    version: '0.1.0',
    capabilities: {
      streaming: true,
    },
    skills: [
      {
        id: 'echo',
        name: 'Echo',
        description: 'Echoes back the input',
        tags: ['echo', 'test'],
      },
    ],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  };

  const taskStore = new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, echoExecutor);

  const app = express();

  app.use(
    '/.well-known/agent-card.json',
    agentCardHandler({ agentCardProvider: async () => agentCard }),
  );

  app.use(
    '/a2a/jsonrpc',
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );

  const server = app.listen(port);
  return server;
}

/**
 * Runs the full spike: starts server, sends a message via ClientFactory, iterates the stream.
 * Returns the collected stream events for assertions.
 */
export async function runSpike(port: number) {
  const server = createSpikeServer(port);

  // Wait for the server to be listening before connecting the client
  await new Promise<void>((resolve) => {
    server.once('listening', resolve);
    if (server.listening) resolve();
  });

  try {
    // Create client via ClientFactory (NOT deprecated A2AClient)
    const factory = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {}),
    );
    const client = await factory.createFromUrl(`http://localhost:${port}`);

    // Build a properly-formed Message
    const message: Message = {
      kind: 'message',
      messageId: crypto.randomUUID(),
      role: 'user',
      parts: [{ kind: 'text', text: 'hello' }],
    };

    // Send via streaming — collect raw A2AStreamEventData events
    const events: Array<Message | import('@a2a-js/sdk').Task | import('@a2a-js/sdk').TaskStatusUpdateEvent | import('@a2a-js/sdk').TaskArtifactUpdateEvent> = [];
    for await (const event of client.sendMessageStream({ message })) {
      events.push(event);
    }

    return events;
  } finally {
    server.close();
  }
}
