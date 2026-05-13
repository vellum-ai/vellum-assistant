import { describe, test, expect, afterAll } from 'bun:test';
import type { Server } from 'http';
import type {
  AgentCard,
  Message,
  Task,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  DataPart,
} from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { ClientFactory, ClientFactoryOptions } from '@a2a-js/sdk/client';
import express from 'express';
import { VellumSocialExecutor, type PeerConfig } from '../executor.js';
import { makeRequestPart } from '../extension.js';
import type { VellumSocialResponseData, VellumSocialWorkingData } from '../types.js';
import * as fs from 'fs';
import * as path from 'path';

type StreamEvent = Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

function createTestServer(config: PeerConfig): { server: Server; port: number } {
  const port = 30_000 + Math.floor(Math.random() * 10_000);

  const agentCard: AgentCard = {
    name: config.name,
    url: `http://localhost:${port}/a2a/jsonrpc`,
    description: `Test peer: ${config.name}`,
    protocolVersion: '0.2.0',
    version: '0.1.0',
    capabilities: { streaming: true },
    skills: [{ id: 'social', name: 'Social', description: 'Social response', tags: ['social'] }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  };

  const executor = new VellumSocialExecutor(config);
  const taskStore = new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

  const app = express();
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: async () => agentCard }));
  app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  const server = app.listen(port);
  return { server, port };
}

async function waitForListening(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    const onError = (err: Error) => { server.removeListener('listening', onListening); reject(err); };
    server.once('listening', onListening);
    server.once('error', onError);
    if (server.listening) { server.removeListener('error', onError); resolve(); }
  });
}

async function sendAndCollect(port: number, parts: Message['parts']): Promise<StreamEvent[]> {
  const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {}));
  const client = await factory.createFromUrl(`http://localhost:${port}`);

  const message: Message = {
    kind: 'message',
    messageId: crypto.randomUUID(),
    role: 'user',
    parts,
  };

  const events: StreamEvent[] = [];
  for await (const event of client.sendMessageStream({ message })) {
    events.push(event);
  }
  return events;
}

function buildRequestParts(correlationId: string) {
  return [
    { kind: 'text' as const, text: 'Can you attend the meeting?' },
    makeRequestPart({
      connection_id: 'conn_test_123',
      sender_relationship: 'colleague',
      correlation_id: correlationId,
    }),
  ];
}

function findStatusEvents(events: StreamEvent[], state?: string): TaskStatusUpdateEvent[] {
  return events.filter(
    (e): e is TaskStatusUpdateEvent =>
      e.kind === 'status-update' && (state === undefined || (e as TaskStatusUpdateEvent).status.state === state),
  );
}

function findArtifactEvents(events: StreamEvent[]): TaskArtifactUpdateEvent[] {
  return events.filter((e): e is TaskArtifactUpdateEvent => e.kind === 'artifact-update');
}

function extractResponseData(artifact: TaskArtifactUpdateEvent): VellumSocialResponseData | undefined {
  const dataPart = artifact.artifact.parts.find((p) => p.kind === 'data') as DataPart | undefined;
  if (!dataPart) return undefined;
  return dataPart.data as unknown as VellumSocialResponseData;
}

function extractWorkingData(status: TaskStatusUpdateEvent): VellumSocialWorkingData | undefined {
  const message = status.status.message;
  if (!message) return undefined;
  const dataPart = message.parts.find((p) => p.kind === 'data') as DataPart | undefined;
  if (!dataPart) return undefined;
  return dataPart.data as unknown as VellumSocialWorkingData;
}

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

describe('VellumSocialExecutor', () => {
  test('standing_preference: artifact then completed', async () => {
    const config: PeerConfig = {
      name: 'Standing Pref Peer',
      responseText: 'I always attend Friday standups.',
      strategy: 'standing_preference',
      humanDelayMs: 0,
    };
    const { server, port } = createTestServer(config);
    servers.push(server);
    await waitForListening(server);

    const events = await sendAndCollect(port, buildRequestParts('corr_sp_001'));

    const artifacts = findArtifactEvents(events);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifact.parts.some((p) => p.kind === 'text' && (p as { text: string }).text === config.responseText)).toBe(true);

    const responseData = extractResponseData(artifacts[0]);
    expect(responseData).toBeDefined();
    expect(responseData!.response_basis).toBe('standing_preference');
    expect(responseData!.correlation_id).toBe('corr_sp_001');

    const completedStatuses = findStatusEvents(events, 'completed');
    expect(completedStatuses).toHaveLength(1);
    expect(completedStatuses[0].final).toBe(true);

    // Artifact must come before completed status
    const artifactIdx = events.indexOf(artifacts[0]);
    const completedIdx = events.indexOf(completedStatuses[0]);
    expect(artifactIdx).toBeLessThan(completedIdx);
  }, 10_000);

  test('hitl_confirm: working then artifact then completed', async () => {
    const config: PeerConfig = {
      name: 'HITL Confirm Peer',
      responseText: 'Yes, confirmed by human.',
      strategy: 'hitl_confirm',
      humanDelayMs: 50,
    };
    const { server, port } = createTestServer(config);
    servers.push(server);
    await waitForListening(server);

    const events = await sendAndCollect(port, buildRequestParts('corr_hc_001'));

    // Working status with awaiting_human_input
    const workingStatuses = findStatusEvents(events, 'working');
    expect(workingStatuses.length).toBeGreaterThanOrEqual(1);
    const workingData = extractWorkingData(workingStatuses[0]);
    expect(workingData).toBeDefined();
    expect(workingData!.hitl_state).toBe('awaiting_human_input');
    expect(workingData!.correlation_id).toBe('corr_hc_001');

    // Artifact with confirmed response
    const artifacts = findArtifactEvents(events);
    expect(artifacts).toHaveLength(1);
    const responseData = extractResponseData(artifacts[0]);
    expect(responseData).toBeDefined();
    expect(responseData!.response_basis).toBe('confirmed');

    // Completed status
    const completedStatuses = findStatusEvents(events, 'completed');
    expect(completedStatuses).toHaveLength(1);
    expect(completedStatuses[0].final).toBe(true);

    // Order: working < artifact < completed
    const workingIdx = events.indexOf(workingStatuses[0]);
    const artifactIdx = events.indexOf(artifacts[0]);
    const completedIdx = events.indexOf(completedStatuses[0]);
    expect(workingIdx).toBeLessThan(artifactIdx);
    expect(artifactIdx).toBeLessThan(completedIdx);
  }, 10_000);

  test('hitl_stale_infer: two working statuses then artifact then completed', async () => {
    const config: PeerConfig = {
      name: 'HITL Stale Infer Peer',
      responseText: 'Inferred: probably yes.',
      strategy: 'hitl_stale_infer',
      humanDelayMs: 50,
    };
    const { server, port } = createTestServer(config);
    servers.push(server);
    await waitForListening(server);

    const events = await sendAndCollect(port, buildRequestParts('corr_si_001'));

    // Two working statuses
    const workingStatuses = findStatusEvents(events, 'working');
    expect(workingStatuses.length).toBeGreaterThanOrEqual(2);

    const working1Data = extractWorkingData(workingStatuses[0]);
    expect(working1Data).toBeDefined();
    expect(working1Data!.hitl_state).toBe('awaiting_human_input');

    const working2Data = extractWorkingData(workingStatuses[1]);
    expect(working2Data).toBeDefined();
    expect(working2Data!.hitl_state).toBe('awaiting_human_input_stale');

    // Artifact with inferred response
    const artifacts = findArtifactEvents(events);
    expect(artifacts).toHaveLength(1);
    const responseData = extractResponseData(artifacts[0]);
    expect(responseData).toBeDefined();
    expect(responseData!.response_basis).toBe('inferred');

    // Completed status
    const completedStatuses = findStatusEvents(events, 'completed');
    expect(completedStatuses).toHaveLength(1);
    expect(completedStatuses[0].final).toBe(true);

    // Order: working1 < working2 < artifact < completed
    const w1Idx = events.indexOf(workingStatuses[0]);
    const w2Idx = events.indexOf(workingStatuses[1]);
    const artifactIdx = events.indexOf(artifacts[0]);
    const completedIdx = events.indexOf(completedStatuses[0]);
    expect(w1Idx).toBeLessThan(w2Idx);
    expect(w2Idx).toBeLessThan(artifactIdx);
    expect(artifactIdx).toBeLessThan(completedIdx);
  }, 10_000);

  test('hitl_unreachable: working then artifact then completed', async () => {
    const config: PeerConfig = {
      name: 'HITL Unreachable Peer',
      responseText: 'No response received',
      strategy: 'hitl_unreachable',
      humanDelayMs: 50,
    };
    const { server, port } = createTestServer(config);
    servers.push(server);
    await waitForListening(server);

    const events = await sendAndCollect(port, buildRequestParts('corr_ur_001'));

    // Working status with awaiting_human_input
    const workingStatuses = findStatusEvents(events, 'working');
    expect(workingStatuses.length).toBeGreaterThanOrEqual(1);
    const workingData = extractWorkingData(workingStatuses[0]);
    expect(workingData).toBeDefined();
    expect(workingData!.hitl_state).toBe('awaiting_human_input');

    // Artifact with unreachable response and "No response received" text
    const artifacts = findArtifactEvents(events);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifact.parts.some((p) => p.kind === 'text' && (p as { text: string }).text === 'No response received')).toBe(true);
    const responseData = extractResponseData(artifacts[0]);
    expect(responseData).toBeDefined();
    expect(responseData!.response_basis).toBe('unreachable');

    // Completed status
    const completedStatuses = findStatusEvents(events, 'completed');
    expect(completedStatuses).toHaveLength(1);
    expect(completedStatuses[0].final).toBe(true);

    // Order: working < artifact < completed
    const workingIdx = events.indexOf(workingStatuses[0]);
    const artifactIdx = events.indexOf(artifacts[0]);
    const completedIdx = events.indexOf(completedStatuses[0]);
    expect(workingIdx).toBeLessThan(artifactIdx);
    expect(artifactIdx).toBeLessThan(completedIdx);
  }, 10_000);

  test('missing extension data results in failed status', async () => {
    const config: PeerConfig = {
      name: 'Missing Ext Peer',
      responseText: 'Should not appear',
      strategy: 'standing_preference',
      humanDelayMs: 0,
    };
    const { server, port } = createTestServer(config);
    servers.push(server);
    await waitForListening(server);

    // Send message without any Vellum social extension data
    const events = await sendAndCollect(port, [{ kind: 'text', text: 'No extension here' }]);

    const failedStatuses = findStatusEvents(events, 'failed');
    expect(failedStatuses).toHaveLength(1);
    expect(failedStatuses[0].final).toBe(true);

    const failMessage = failedStatuses[0].status.message;
    expect(failMessage).toBeDefined();
    expect(failMessage!.kind).toBe('message');
    expect(failMessage!.messageId).toBeTruthy();
    expect(failMessage!.role).toBe('agent');
    expect(failMessage!.parts.some((p) => p.kind === 'text' && (p as { text: string }).text === 'Missing x-vellum-social-v1 extension data')).toBe(true);

    // No artifacts should be published
    const artifacts = findArtifactEvents(events);
    expect(artifacts).toHaveLength(0);
  }, 10_000);

  test('scope stub: TODO comment is present in executor source', () => {
    const executorSource = fs.readFileSync(
      path.join(import.meta.dir, '..', 'executor.ts'),
      'utf-8',
    );
    expect(executorSource).toContain('// TODO: enforce scope');
  });
});
