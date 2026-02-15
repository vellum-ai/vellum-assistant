import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Provider } from '../providers/types.js';
import type { CuObservation } from '../daemon/ipc-protocol.js';

let capturedWorkingDir: string | undefined;

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../util/platform.js', () => ({
  getRootDir: () => '/tmp',
  getDataDir: () => '/tmp/data',
  getSandboxRootDir: () => '/tmp/sandbox',
  getSandboxWorkingDir: () => '/tmp/sandbox/fs',
  getPlatformName: () => 'linux',
  getClipboardCommand: () => null,
  getSocketPath: () => '/tmp/test.sock',
  getPidPath: () => '/tmp/test.pid',
  getDbPath: () => '/tmp/data/db/assistant.db',
  getLogPath: () => '/tmp/test.log',
  getHistoryPath: () => '/tmp/data/history',
  getHooksDir: () => '/tmp/hooks',
  removeSocketFile: () => {},
  ensureDataDir: () => {},
  migrateToDataLayout: () => {},
  isMacOS: () => false,
  isLinux: () => true,
  isWindows: () => false,
}));

mock.module('../tools/executor.js', () => ({
  ToolExecutor: class {
    constructor(..._args: unknown[]) {}

    async execute(
      _name: string,
      _input: Record<string, unknown>,
      context: { workingDir: string },
    ) {
      capturedWorkingDir = context.workingDir;
      return { content: 'ok', isError: false };
    }
  },
}));

mock.module('../agent/loop.js', () => ({
  AgentLoop: class {
    private readonly runTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;

    constructor(
      _provider: unknown,
      _systemPrompt: unknown,
      _options: unknown,
      _toolDefs: unknown,
      toolExecutor: (name: string, input: Record<string, unknown>) => Promise<unknown>,
    ) {
      this.runTool = toolExecutor;
    }

    async run(_messages: unknown, _onEvent: unknown, _signal?: AbortSignal): Promise<void> {
      await this.runTool('cu_click', { element_id: 1 });
    }
  },
}));

const { ComputerUseSession } = await import('../daemon/computer-use-session.js');

describe('ComputerUseSession working directory', () => {
  beforeEach(() => {
    capturedWorkingDir = undefined;
  });

  test('uses sandbox working directory for tool execution context', async () => {
    const provider: Provider = {
      name: 'mock-provider',
      async sendMessage() {
        return {
          content: [{ type: 'text', text: 'unused' }],
          model: 'mock-model',
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'end_turn',
        };
      },
    };

    const session = new ComputerUseSession(
      'cu-sandbox-1',
      'test task',
      1440,
      900,
      provider,
      () => {},
    );

    const observation: CuObservation = {
      type: 'cu_observation',
      sessionId: 'cu-sandbox-1',
      axTree: 'Window "Test" [1]',
    };

    await session.handleObservation(observation);

    expect(capturedWorkingDir).toBe('/tmp/sandbox/fs');
  });
});
