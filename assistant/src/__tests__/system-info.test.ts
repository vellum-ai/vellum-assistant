import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { ToolContext } from '../tools/types.js';
import * as realOs from 'node:os';
import * as realChildProcess from 'node:child_process';

// ---------------------------------------------------------------------------
// Mock os module — spread real module so imports like `homedir` still work
// ---------------------------------------------------------------------------
const mockOs = {
  ...realOs,
  totalmem: mock(() => 34_359_738_368), // 32 GB
  freemem: mock(() => 10_307_921_100), // ~9.6 GB
  cpus: mock(() =>
    Array.from({ length: 12 }, () => ({
      model: 'Apple M2 Max',
      speed: 3490,
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    })),
  ),
  loadavg: mock(() => [2.34, 1.87, 1.52]),
  uptime: mock(() => 277920), // 3 days, 5 hours, 12 minutes
  hostname: mock(() => 'MacBook-Pro'),
  type: mock(() => 'Darwin'),
  release: mock(() => '24.6.0'),
  arch: mock(() => 'arm64'),
};

mock.module('node:os', () => mockOs);

// ---------------------------------------------------------------------------
// Mock child_process module — spread real module, override execSync
// ---------------------------------------------------------------------------
const dfOutput = `Filesystem     Size   Used  Avail Capacity  iused ifree %iused  Mounted on
/dev/disk3s1  1.0Ti  456Gi  544Gi    46%   500000 10000000    5%   /
`;

const batteryOutput = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=12345)	87%; charging; 1:23 remaining present: true
`;

const mockExecSync = mock((cmd: string): string => {
  if (cmd === 'df -h /') return dfOutput;
  if (cmd === 'pmset -g batt') return batteryOutput;
  throw new Error(`Unknown command: ${cmd}`);
});

mock.module('node:child_process', () => ({
  ...realChildProcess,
  execSync: mockExecSync,
}));

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------
const { buildSystemInfo } = await import('../tools/system/system-info.js');
const { getTool } = await import('../tools/registry.js');

describe('system_info', () => {
  beforeEach(() => {
    mockOs.totalmem.mockImplementation(() => 34_359_738_368);
    mockOs.freemem.mockImplementation(() => 10_307_921_100);
    mockOs.cpus.mockImplementation(() =>
      Array.from({ length: 12 }, () => ({
        model: 'Apple M2 Max',
        speed: 3490,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      })),
    );
    mockOs.loadavg.mockImplementation(() => [2.34, 1.87, 1.52]);
    mockOs.uptime.mockImplementation(() => 277920);
    mockOs.hostname.mockImplementation(() => 'MacBook-Pro');
    mockOs.type.mockImplementation(() => 'Darwin');
    mockOs.release.mockImplementation(() => '24.6.0');
    mockOs.arch.mockImplementation(() => 'arm64');

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'df -h /') return dfOutput;
      if (cmd === 'pmset -g batt') return batteryOutput;
      throw new Error(`Unknown command: ${cmd}`);
    });
  });

  test('returns all sections by default', () => {
    const result = buildSystemInfo();
    expect(result).toContain('## System Info');
    expect(result).toContain('MacBook-Pro');
    expect(result).toContain('OS: Darwin 24.6.0 (arm64)');
    expect(result).toContain('Uptime:');
    expect(result).toContain('### Memory');
    expect(result).toContain('### CPU');
    expect(result).toContain('### Disk (/)');
    expect(result).toContain('### Battery');
  });

  test('formats memory correctly', () => {
    const result = buildSystemInfo(['memory']);
    expect(result).toContain('### Memory');
    expect(result).toContain('32.0 GB');
    expect(result).toContain('Free:');
    expect(result).toContain('Used:');
    expect(result).toMatch(/\d+% used/);
  });

  test('formats CPU correctly', () => {
    const result = buildSystemInfo(['cpu']);
    expect(result).toContain('### CPU');
    expect(result).toContain('Apple M2 Max');
    expect(result).toContain('12 cores');
    expect(result).toContain('Load Average: 2.34, 1.87, 1.52');
  });

  test('formats disk correctly', () => {
    const result = buildSystemInfo(['disk']);
    expect(result).toContain('### Disk (/)');
    expect(result).toContain('1.0Ti');
    expect(result).toContain('456Gi');
    expect(result).toContain('544Gi');
    expect(result).toContain('46%');
  });

  test('formats battery correctly', () => {
    const result = buildSystemInfo(['battery']);
    expect(result).toContain('### Battery');
    expect(result).toContain('87%');
    expect(result).toContain('Charging');
  });

  test('formats uptime correctly', () => {
    const result = buildSystemInfo(['uptime']);
    expect(result).toContain('Uptime: 3 days, 5 hours, 12 minutes');
  });

  test('formats OS correctly', () => {
    const result = buildSystemInfo(['os']);
    expect(result).toContain('OS: Darwin 24.6.0 (arm64)');
  });

  test('filters to requested sections only', () => {
    const result = buildSystemInfo(['memory', 'cpu']);
    expect(result).toContain('### Memory');
    expect(result).toContain('### CPU');
    expect(result).not.toContain('### Disk');
    expect(result).not.toContain('### Battery');
    expect(result).not.toContain('Uptime:');
    expect(result).not.toContain('OS:');
  });

  test('ignores invalid section names', () => {
    const result = buildSystemInfo(['memory', 'invalid_section']);
    expect(result).toContain('### Memory');
    expect(result).not.toContain('invalid_section');
  });

  test('returns error for no valid sections', () => {
    const result = buildSystemInfo(['invalid']);
    expect(result).toContain('Error: No valid sections specified');
    expect(result).toContain('memory');
    expect(result).toContain('cpu');
  });

  test('execute returns isError true when only invalid sections are provided', async () => {
    const tool = getTool('system_info');
    expect(tool).toBeDefined();
    const result = await tool!.execute({ sections: ['memroy', 'bogus'] }, {} as ToolContext);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Error: No valid sections specified');
  });

  test('handles missing battery gracefully (desktop Mac)', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'df -h /') return dfOutput;
      if (cmd === 'pmset -g batt') throw new Error('Command failed');
      throw new Error(`Unknown command: ${cmd}`);
    });

    const result = buildSystemInfo(['battery']);
    expect(result).toContain('### Battery');
    expect(result).toContain('No battery information available');
  });

  test('handles disk command failure gracefully', () => {
    mockExecSync.mockImplementation((_cmd: string) => {
      throw new Error('Command failed');
    });

    const result = buildSystemInfo(['disk']);
    expect(result).toContain('### Disk (/)');
    expect(result).toContain('Unable to retrieve disk information');
  });

  test('formats uptime with singular units correctly', () => {
    mockOs.uptime.mockImplementation(() => 90060); // 1 day, 1 hour, 1 minute
    const result = buildSystemInfo(['uptime']);
    expect(result).toContain('1 day, 1 hour, 1 minute');
  });

  test('formats uptime with zero days correctly', () => {
    mockOs.uptime.mockImplementation(() => 7320); // 0 days, 2 hours, 2 minutes
    const result = buildSystemInfo(['uptime']);
    expect(result).toContain('2 hours, 2 minutes');
    expect(result).not.toContain('day');
  });

  test('detects discharging battery state', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'df -h /') return dfOutput;
      if (cmd === 'pmset -g batt') {
        return `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=12345)\t45%; discharging; 3:45 remaining present: true
`;
      }
      throw new Error(`Unknown command: ${cmd}`);
    });

    const result = buildSystemInfo(['battery']);
    expect(result).toContain('45%');
    expect(result).toContain('Discharging');
  });

  test('detects charged battery state', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'df -h /') return dfOutput;
      if (cmd === 'pmset -g batt') {
        return `Now drawing from 'AC Power'
 -InternalBattery-0 (id=12345)\t100%; charged; 0:00 remaining present: true
`;
      }
      throw new Error(`Unknown command: ${cmd}`);
    });

    const result = buildSystemInfo(['battery']);
    expect(result).toContain('100%');
    expect(result).toContain('Charged');
  });

  test('battery output with no percentage returns fallback', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'df -h /') return dfOutput;
      if (cmd === 'pmset -g batt') return 'No battery info';
      throw new Error(`Unknown command: ${cmd}`);
    });

    const result = buildSystemInfo(['battery']);
    expect(result).toContain('No battery information available');
  });
});
