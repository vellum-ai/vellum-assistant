import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realChildProcess from 'node:child_process';

const execSyncMock = mock((_command: string, _opts?: unknown): unknown => undefined);

mock.module('node:child_process', () => ({
  ...realChildProcess,
  execSync: execSyncMock,
}));

let mockIsMacOS = false;
let mockIsLinux = true;

mock.module('../util/platform.js', () => ({
  isMacOS: () => mockIsMacOS,
  isLinux: () => mockIsLinux,
  getRootDir: () => '/tmp/vellum-test',
  getDataDir: () => '/tmp/vellum-test/data',
  getSocketPath: () => '/tmp/vellum-test/vellum.sock',
  getDbPath: () => '/tmp/vellum-test/data/db/assistant.db',
  getLogPath: () => '/tmp/vellum-test/data/logs/daemon.log',
  getSandboxRootDir: () => '/tmp/vellum-test/sandbox',
  getSandboxWorkingDir: () => '/tmp/vellum-test/sandbox/workspace',
  ensureDataDir: () => {},
  getHistoryPath: () => '/tmp/vellum-test/data/history',
  getHooksDir: () => '/tmp/vellum-test/hooks',
  getPidPath: () => '/tmp/vellum-test/data/daemon.pid',
}));

const { getFirewallDiagnostics } = await import(
  '../tools/network/firewall-diagnostics.js'
);

beforeEach(() => {
  execSyncMock.mockReset();
  mockIsMacOS = false;
  mockIsLinux = true;
});

describe('getFirewallDiagnostics — Linux with nftables', () => {
  test('returns nftables rules when nft is available', () => {
    /**
     * Tests that nftables rules are captured on Linux.
     */

    // GIVEN nft list ruleset returns rules
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.startsWith('nft list ruleset')) {
        return 'table inet filter {\n  chain input {\n    type filter hook input priority 0;\n  }\n}';
      }
      return null;
    });

    // WHEN we run firewall diagnostics
    const result = getFirewallDiagnostics();

    // THEN it should report Linux platform and be available
    expect(result.platform).toBe('Linux');
    expect(result.available).toBe(true);

    // AND it should include the nftables rule set
    const nftRuleSet = result.ruleSets.find((rs: { source: string }) => rs.source.includes('nftables'));
    expect(nftRuleSet).toBeDefined();
    expect(nftRuleSet!.rules).toContain('table inet filter');
  });

  test('reports empty ruleset when nft returns nothing', () => {
    /**
     * Tests that an empty nftables ruleset is handled gracefully.
     */

    // GIVEN nft list ruleset returns empty output
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.startsWith('nft list ruleset')) {
        return '';
      }
      return null;
    });

    // WHEN we run firewall diagnostics
    const result = getFirewallDiagnostics();

    // THEN the nftables rule set should show empty
    const nftRuleSet = result.ruleSets.find((rs: { source: string }) => rs.source.includes('nftables'));
    expect(nftRuleSet).toBeDefined();
    expect(nftRuleSet!.rules).toBe('(empty ruleset)');
  });
});

describe('getFirewallDiagnostics — Linux with iptables', () => {
  test('returns iptables rules when iptables is available', () => {
    /**
     * Tests that iptables rules are captured on Linux.
     */

    // GIVEN only iptables is available (nft fails)
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.startsWith('nft')) {
        throw new Error('command not found');
      }
      if (typeof cmd === 'string' && cmd.startsWith('iptables')) {
        return 'Chain INPUT (policy ACCEPT)\ntarget     prot opt source               destination';
      }
      if (typeof cmd === 'string' && cmd.startsWith('ufw')) {
        throw new Error('command not found');
      }
      return null;
    });

    // WHEN we run firewall diagnostics
    const result = getFirewallDiagnostics();

    // THEN it should be available with iptables rules
    expect(result.available).toBe(true);
    const iptRuleSet = result.ruleSets.find((rs: { source: string }) => rs.source.includes('iptables'));
    expect(iptRuleSet).toBeDefined();
    expect(iptRuleSet!.rules).toContain('Chain INPUT');
  });
});

describe('getFirewallDiagnostics — Linux with ufw', () => {
  test('returns ufw status when ufw is available', () => {
    /**
     * Tests that ufw status is captured on Linux.
     */

    // GIVEN only ufw is available (nft and iptables fail)
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.startsWith('nft')) {
        throw new Error('command not found');
      }
      if (typeof cmd === 'string' && cmd.startsWith('iptables')) {
        throw new Error('command not found');
      }
      if (typeof cmd === 'string' && cmd.startsWith('ufw')) {
        return 'Status: active\n\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW       Anywhere';
      }
      return null;
    });

    // WHEN we run firewall diagnostics
    const result = getFirewallDiagnostics();

    // THEN it should be available with ufw rules
    expect(result.available).toBe(true);
    const ufwRuleSet = result.ruleSets.find((rs: { source: string }) => rs.source.includes('ufw'));
    expect(ufwRuleSet).toBeDefined();
    expect(ufwRuleSet!.rules).toContain('Status: active');
  });
});

describe('getFirewallDiagnostics — Linux with no firewall tools', () => {
  test('reports unavailable when no firewall tools are found', () => {
    /**
     * Tests that the diagnostic reports unavailable when no tools exist.
     */

    // GIVEN all firewall commands fail
    execSyncMock.mockImplementation(() => {
      throw new Error('command not found');
    });

    // WHEN we run firewall diagnostics
    const result = getFirewallDiagnostics();

    // THEN it should report unavailable with an error
    expect(result.platform).toBe('Linux');
    expect(result.available).toBe(false);
    expect(result.ruleSets).toHaveLength(0);
    expect(result.error).toContain('No firewall tools found');
  });
});

describe('getFirewallDiagnostics — macOS', () => {
  test('returns application firewall state', () => {
    /**
     * Tests that macOS application firewall state is captured.
     */

    // GIVEN we are on macOS and socketfilterfw returns state
    mockIsMacOS = true;
    mockIsLinux = false;
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('socketfilterfw')) {
        return 'Firewall is enabled. (State = 1)';
      }
      if (typeof cmd === 'string' && cmd.includes('pfctl -sr')) {
        return 'pass in quick on lo0 all flags S/SA';
      }
      return null;
    });

    // WHEN we run firewall diagnostics
    const result = getFirewallDiagnostics();

    // THEN it should report macOS platform and be available
    expect(result.platform).toBe('macOS');
    expect(result.available).toBe(true);

    // AND it should include the application firewall
    const appFirewall = result.ruleSets.find((rs: { source: string }) => rs.source.includes('Application Firewall'));
    expect(appFirewall).toBeDefined();
    expect(appFirewall!.rules).toContain('Firewall is enabled');

    // AND it should include pfctl rules
    const pfRuleSet = result.ruleSets.find((rs: { source: string }) => rs.source.includes('Packet Filter'));
    expect(pfRuleSet).toBeDefined();
    expect(pfRuleSet!.rules).toContain('pass in quick');
  });

  test('falls back to pfctl info when pfctl -sr returns empty', () => {
    /**
     * Tests pfctl info fallback when no rules are returned.
     */

    // GIVEN pfctl -sr returns empty but pfctl -s info works
    mockIsMacOS = true;
    mockIsLinux = false;
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('socketfilterfw')) {
        throw new Error('not found');
      }
      if (typeof cmd === 'string' && cmd.includes('pfctl -sr')) {
        return '';
      }
      if (typeof cmd === 'string' && cmd.includes('pfctl -s info')) {
        return 'Status: Enabled';
      }
      return null;
    });

    // WHEN we run firewall diagnostics
    const result = getFirewallDiagnostics();

    // THEN it should include pfctl info
    const pfInfo = result.ruleSets.find((rs: { source: string }) => rs.source.includes('pfctl -s info'));
    expect(pfInfo).toBeDefined();
    expect(pfInfo!.rules).toContain('Status: Enabled');
  });

  test('reports unavailable when no macOS firewall tools respond', () => {
    /**
     * Tests error handling when no macOS firewall tools are accessible.
     */

    // GIVEN all macOS firewall commands fail
    mockIsMacOS = true;
    mockIsLinux = false;
    execSyncMock.mockImplementation(() => {
      throw new Error('not found');
    });

    // WHEN we run firewall diagnostics
    const result = getFirewallDiagnostics();

    // THEN it should report unavailable
    expect(result.platform).toBe('macOS');
    expect(result.available).toBe(false);
    expect(result.error).toContain('elevated privileges');
  });
});

describe('getFirewallDiagnostics — unsupported platform', () => {
  test('reports unsupported for non-macOS/Linux platforms', () => {
    /**
     * Tests that unsupported platforms get a clear error.
     */

    // GIVEN neither macOS nor Linux
    mockIsMacOS = false;
    mockIsLinux = false;

    // WHEN we run firewall diagnostics
    const result = getFirewallDiagnostics();

    // THEN it should report unsupported
    expect(result.available).toBe(false);
    expect(result.error).toContain('not supported');
  });
});

describe('getFirewallDiagnostics — multiple Linux firewall tools', () => {
  test('returns all available firewall rule sets', () => {
    /**
     * Tests that multiple firewall tools are all reported when available.
     */

    // GIVEN all Linux firewall tools are available
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.startsWith('nft list ruleset')) {
        return 'table inet filter {}';
      }
      if (typeof cmd === 'string' && cmd.startsWith('iptables')) {
        return 'Chain INPUT (policy ACCEPT)';
      }
      if (typeof cmd === 'string' && cmd.startsWith('ufw')) {
        return 'Status: inactive';
      }
      return null;
    });

    // WHEN we run firewall diagnostics
    const result = getFirewallDiagnostics();

    // THEN all three rule sets should be present
    expect(result.available).toBe(true);
    expect(result.ruleSets).toHaveLength(3);
    expect(result.ruleSets.find((rs: { source: string }) => rs.source.includes('nftables'))).toBeDefined();
    expect(result.ruleSets.find((rs: { source: string }) => rs.source.includes('iptables'))).toBeDefined();
    expect(result.ruleSets.find((rs: { source: string }) => rs.source.includes('ufw'))).toBeDefined();
  });
});
