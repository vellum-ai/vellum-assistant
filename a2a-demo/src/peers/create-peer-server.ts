import type { Server } from 'node:http';
import type { Express } from 'express';
import express from 'express';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { VellumSocialExecutor, type PeerConfig } from '../executor.js';
import type { VellumAgentCard } from '../types.js';

export interface CreatePeerServerOptions {
  name: string;
  port: number;
  assistantId: string;
  config: PeerConfig;
}

export interface PeerServer {
  app: Express;
  server: Server;
}

export function createPeerServer(options: CreatePeerServerOptions): PeerServer {
  const { name, port, config } = options;

  const card: VellumAgentCard = {
    name: `${name}'s Assistant`,
    url: `http://localhost:${port}/a2a/jsonrpc`,
    description: `Mock peer for A2A demo — exercises ${config.strategy}`,
    protocolVersion: '0.3.0',
    version: '0.1.0',
    capabilities: { streaming: true },
    skills: [
      {
        id: 'coffee_order',
        name: 'Coffee Order',
        description: 'Responds to coffee order requests',
        tags: ['coffee', 'social'],
      },
    ],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    'x-vellum-social-v1': true,
  };

  const taskStore = new InMemoryTaskStore();
  const executor = new VellumSocialExecutor(config);
  const requestHandler = new DefaultRequestHandler(card, taskStore, executor);

  const app = express();

  app.use(
    '/.well-known/agent-card.json',
    agentCardHandler({ agentCardProvider: async () => card }),
  );

  app.use(
    '/a2a/jsonrpc',
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );

  const server = app.listen(port);

  return { app, server };
}
