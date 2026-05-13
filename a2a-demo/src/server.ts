import type { AgentCard } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import express from 'express';
import path from 'path';

import { EventBus } from './events.js';
import { VellumSocialExecutor, type PeerConfig } from './executor.js';
import { runCoffeeScenario } from './coffee-run.js';
import type { Connection, ConnectionsConfig, VellumAgentCard } from './types.js';

import connectionsJson from './connections.json' with { type: 'json' };

interface ServerOptions {
  port?: number;
  publicBaseUrl?: string;
  assistantName?: string;
  assistantId?: string;
  coffeeResponse?: string;
  responseStrategy?: PeerConfig['strategy'];
  connections?: Connection[];
}

/**
 * Create and start the main A2A demo server.
 * Accepts DI options for testing and configuration.
 */
export function createServer(options: ServerOptions = {}) {
  const port = options.port ?? (Number(process.env.PORT) || 3000);
  const publicBaseUrl = options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
  const assistantName = options.assistantName ?? process.env.ASSISTANT_NAME ?? 'Demo Assistant';
  const assistantId = options.assistantId ?? process.env.ASSISTANT_ID ?? 'demo-assistant-1';
  const coffeeResponse = options.coffeeResponse ?? process.env.COFFEE_RESPONSE ?? 'I appreciate the offer!';
  const responseStrategy = (options.responseStrategy ?? process.env.RESPONSE_STRATEGY ?? 'standing_preference') as PeerConfig['strategy'];
  const connections = options.connections ?? (connectionsJson as ConnectionsConfig).connections;

  const agentCard: VellumAgentCard = {
    'x-vellum-social-v1': true,
    name: assistantName,
    url: `${publicBaseUrl}/a2a/jsonrpc`,
    description: `${assistantName} — A2A demo assistant with Vellum social extension`,
    protocolVersion: '0.3.0',
    version: '0.1.0',
    capabilities: {
      streaming: true,
    },
    skills: [
      {
        id: 'coffee_order',
        name: 'Coffee Order',
        description: 'Respond to coffee run requests',
        tags: ['coffee', 'social'],
      },
    ],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  };

  const peerConfig: PeerConfig = {
    name: assistantName,
    responseText: coffeeResponse,
    strategy: responseStrategy,
    humanDelayMs: 2000,
  };

  const taskStore = new InMemoryTaskStore();
  const executor = new VellumSocialExecutor(peerConfig);
  const requestHandler = new DefaultRequestHandler(agentCard as AgentCard, taskStore, executor);

  const app = express();

  const eventBus = new EventBus();

  // Agent card endpoint
  app.use(
    '/.well-known/agent-card.json',
    agentCardHandler({ agentCardProvider: async () => agentCard as AgentCard }),
  );

  // JSON-RPC endpoint
  app.use(
    '/a2a/jsonrpc',
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );

  // SSE endpoint
  app.get('/events', (_req, res) => {
    eventBus.addClient(res);
  });

  // Connections endpoint
  app.get('/connections', (_req, res) => {
    res.json({
      owner: { id: assistantId, name: assistantName },
      connections,
    });
  });

  // Coffee run trigger
  app.post('/run/coffee', express.json(), (req, res) => {
    const deadlineSeconds = (req.body as Record<string, unknown>)?.deadlineSeconds as number | undefined;

    // Fire and forget — respond 202 immediately
    runCoffeeScenario({
      deadlineSeconds: deadlineSeconds ?? 15,
      eventBus,
      connections,
    }).catch((err) => {
      console.error('Coffee run failed:', err);
    });

    res.status(202).json({ status: 'started' });
  });

  // Static file serving — serves the built UI
  app.use(express.static(path.resolve(import.meta.dir, '..', 'ui', 'dist')));

  const server = app.listen(port, () => {
    console.log(`${assistantName} running on http://localhost:${port}`);
  });

  return { app, server, eventBus };
}

// When run directly, start the server
if (import.meta.main) {
  createServer();
}
