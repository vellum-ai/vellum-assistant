import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { ChannelReadinessService, REMOTE_TTL_MS } from '../runtime/channel-readiness-service.js';
import type { ChannelProbe, ReadinessCheckResult } from '../runtime/channel-readiness-types.js';

// ── Test helpers ────────────────────────────────────────────────────────────

function makeProbe(
  channel: string,
  localResults: ReadinessCheckResult[],
  remoteResults?: ReadinessCheckResult[],
): ChannelProbe & { localCallCount: number; remoteCallCount: number } {
  const probe = {
    channel,
    localCallCount: 0,
    remoteCallCount: 0,
    runLocalChecks(): ReadinessCheckResult[] {
      probe.localCallCount++;
      return localResults;
    },
    ...(remoteResults !== undefined
      ? {
          async runRemoteChecks(): Promise<ReadinessCheckResult[]> {
            probe.remoteCallCount++;
            return remoteResults;
          },
        }
      : {}),
  };
  return probe;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ChannelReadinessService', () => {
  let service: ChannelReadinessService;

  beforeEach(() => {
    service = new ChannelReadinessService();
  });

  test('local checks run on every call (no caching of local results)', async () => {
    const probe = makeProbe('sms', [
      { name: 'creds', passed: true, message: 'ok' },
    ]);
    service.registerProbe(probe);

    await service.getReadiness('sms');
    await service.getReadiness('sms');

    expect(probe.localCallCount).toBe(2);
  });

  test('cache miss runs local checks and returns snapshot', async () => {
    const probe = makeProbe('sms', [
      { name: 'creds', passed: true, message: 'ok' },
      { name: 'phone', passed: false, message: 'missing' },
    ]);
    service.registerProbe(probe);

    const [snapshot] = await service.getReadiness('sms');

    expect(probe.localCallCount).toBe(1);
    expect(snapshot.channel).toBe('sms');
    expect(snapshot.ready).toBe(false);
    expect(snapshot.localChecks).toHaveLength(2);
    expect(snapshot.reasons).toEqual([
      { code: 'phone', text: 'missing' },
    ]);
  });

  test('includeRemote=true runs remote checks on cache miss', async () => {
    const probe = makeProbe(
      'sms',
      [{ name: 'creds', passed: true, message: 'ok' }],
      [{ name: 'api_check', passed: true, message: 'remote ok' }],
    );
    service.registerProbe(probe);

    const [snapshot] = await service.getReadiness('sms', true);

    expect(probe.remoteCallCount).toBe(1);
    expect(snapshot.remoteChecks).toHaveLength(1);
    expect(snapshot.remoteChecks![0].passed).toBe(true);
  });

  test('cached remote checks reused within TTL', async () => {
    const probe = makeProbe(
      'sms',
      [{ name: 'creds', passed: true, message: 'ok' }],
      [{ name: 'api_check', passed: true, message: 'remote ok' }],
    );
    service.registerProbe(probe);

    // First call populates cache
    await service.getReadiness('sms', true);
    expect(probe.remoteCallCount).toBe(1);

    // Second call within TTL should reuse cache
    const [snapshot] = await service.getReadiness('sms', true);
    expect(probe.remoteCallCount).toBe(1);
    expect(snapshot.remoteChecks).toHaveLength(1);
  });

  test('stale cache triggers remote check re-run', async () => {
    const probe = makeProbe(
      'sms',
      [{ name: 'creds', passed: true, message: 'ok' }],
      [{ name: 'api_check', passed: true, message: 'remote ok' }],
    );
    service.registerProbe(probe);

    // First call
    await service.getReadiness('sms', true);
    expect(probe.remoteCallCount).toBe(1);

    // Manually age the cached snapshot beyond TTL
    const cached = (service as unknown as { snapshots: Map<string, { checkedAt: number }> }).snapshots.get('sms')!;
    cached.checkedAt = Date.now() - REMOTE_TTL_MS - 1;

    // Second call should re-run remote checks
    await service.getReadiness('sms', true);
    expect(probe.remoteCallCount).toBe(2);
  });

  test('invalidateChannel clears cache for specific channel', async () => {
    const probe = makeProbe(
      'sms',
      [{ name: 'creds', passed: true, message: 'ok' }],
      [{ name: 'api_check', passed: true, message: 'remote ok' }],
    );
    service.registerProbe(probe);

    await service.getReadiness('sms', true);
    expect(probe.remoteCallCount).toBe(1);

    service.invalidateChannel('sms');

    // After invalidation, remote checks should run again
    await service.getReadiness('sms', true);
    expect(probe.remoteCallCount).toBe(2);
  });

  test('invalidateAll clears all cached snapshots', async () => {
    const smsProbe = makeProbe(
      'sms',
      [{ name: 'creds', passed: true, message: 'ok' }],
      [{ name: 'api', passed: true, message: 'ok' }],
    );
    const telegramProbe = makeProbe(
      'telegram',
      [{ name: 'token', passed: true, message: 'ok' }],
      [{ name: 'webhook', passed: true, message: 'ok' }],
    );
    service.registerProbe(smsProbe);
    service.registerProbe(telegramProbe);

    await service.getReadiness(undefined, true);
    expect(smsProbe.remoteCallCount).toBe(1);
    expect(telegramProbe.remoteCallCount).toBe(1);

    service.invalidateAll();

    await service.getReadiness(undefined, true);
    expect(smsProbe.remoteCallCount).toBe(2);
    expect(telegramProbe.remoteCallCount).toBe(2);
  });

  test('unknown channel returns unsupported_channel reason', async () => {
    const [snapshot] = await service.getReadiness('carrier_pigeon');

    expect(snapshot.channel).toBe('carrier_pigeon');
    expect(snapshot.ready).toBe(false);
    expect(snapshot.reasons).toEqual([
      { code: 'unsupported_channel', text: 'Channel carrier_pigeon is not supported' },
    ]);
    expect(snapshot.localChecks).toHaveLength(0);
  });

  test('all checks passing yields ready=true', async () => {
    const probe = makeProbe('test', [
      { name: 'a', passed: true, message: 'ok' },
      { name: 'b', passed: true, message: 'ok' },
    ]);
    service.registerProbe(probe);

    const [snapshot] = await service.getReadiness('test');

    expect(snapshot.ready).toBe(true);
    expect(snapshot.reasons).toHaveLength(0);
  });

  test('getReadiness with no channel returns all registered channels', async () => {
    service.registerProbe(makeProbe('sms', [{ name: 'a', passed: true, message: 'ok' }]));
    service.registerProbe(makeProbe('telegram', [{ name: 'b', passed: true, message: 'ok' }]));

    const snapshots = await service.getReadiness();

    expect(snapshots).toHaveLength(2);
    const channels = snapshots.map((s) => s.channel).sort();
    expect(channels).toEqual(['sms', 'telegram']);
  });

  test('failed remote check makes channel not ready', async () => {
    const probe = makeProbe(
      'sms',
      [{ name: 'creds', passed: true, message: 'ok' }],
      [{ name: 'api_check', passed: false, message: 'API unreachable' }],
    );
    service.registerProbe(probe);

    const [snapshot] = await service.getReadiness('sms', true);

    expect(snapshot.ready).toBe(false);
    expect(snapshot.reasons).toEqual([
      { code: 'api_check', text: 'API unreachable' },
    ]);
  });
});
