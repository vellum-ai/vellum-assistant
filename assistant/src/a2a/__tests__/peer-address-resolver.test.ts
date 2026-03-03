import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'peer-address-resolver-test-'));

mock.module('../../util/platform.js', () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
  migrateToDataLayout: () => {},
  migrateToWorkspaceLayout: () => {},
}));

mock.module('../../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  A2A_PROTOCOL_VERSION,
  encodeInviteCode,
  generateInvite,
  _resetIdempotencyStore,
} from '../a2a-connection-service.js';
import { InviteBasedResolver } from '../invite-based-resolver.js';
import type { PeerAddressResolver } from '../peer-address-resolver.js';
import { initializeDb, resetDb } from '../../memory/db.js';

initializeDb();

const MOCK_GATEWAY_URL = 'https://my-assistant.example.com';
const PEER_GATEWAY_URL = 'https://peer-assistant.example.com';

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    // best-effort cleanup
  }
});

// =========================================================================
// Interface conformance
// =========================================================================

describe('PeerAddressResolver interface', () => {
  test('InviteBasedResolver satisfies PeerAddressResolver interface', () => {
    const resolver: PeerAddressResolver = new InviteBasedResolver();
    expect(typeof resolver.resolve).toBe('function');
  });
});

// =========================================================================
// InviteBasedResolver
// =========================================================================

describe('InviteBasedResolver', () => {
  beforeEach(() => {
    _resetIdempotencyStore();
  });

  // ── Success path ──────────────────────────────────────────────────────

  describe('successful resolution', () => {
    test('resolves a valid invite code', async () => {
      const resolver = new InviteBasedResolver();
      const code = encodeInviteCode(PEER_GATEWAY_URL, 'test-token-123');

      const result = await resolver.resolve(code);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.peerGatewayUrl).toBe(PEER_GATEWAY_URL);
      expect(result.inviteToken).toBe('test-token-123');
      expect(result.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
    });

    test('resolves code with leading/trailing whitespace', async () => {
      const resolver = new InviteBasedResolver();
      const code = encodeInviteCode(PEER_GATEWAY_URL, 'token-ws');

      const result = await resolver.resolve(`  ${code}  `);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.peerGatewayUrl).toBe(PEER_GATEWAY_URL);
    });

    test('resolves invite from generateInvite()', async () => {
      const genResult = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      expect(genResult.ok).toBe(true);
      if (!genResult.ok) return;

      const resolver = new InviteBasedResolver();
      const result = await resolver.resolve(genResult.inviteCode);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.peerGatewayUrl).toBe(MOCK_GATEWAY_URL);
      expect(result.inviteToken).toBeTruthy();
      expect(result.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
    });

    test('resolves HTTP invite for localhost', async () => {
      const resolver = new InviteBasedResolver();
      const code = encodeInviteCode('http://localhost:7830', 'local-token');

      const result = await resolver.resolve(code);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.peerGatewayUrl).toBe('http://localhost:7830');
    });

    test('resolves HTTP invite for private IP', async () => {
      const resolver = new InviteBasedResolver();
      const code = encodeInviteCode('http://192.168.1.100:7830', 'lan-token');

      const result = await resolver.resolve(code);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.peerGatewayUrl).toBe('http://192.168.1.100:7830');
    });
  });

  // ── Malformed invites ─────────────────────────────────────────────────

  describe('malformed invite codes', () => {
    test('rejects empty string', async () => {
      const resolver = new InviteBasedResolver();
      const result = await resolver.resolve('');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('malformed');
    });

    test('rejects whitespace-only string', async () => {
      const resolver = new InviteBasedResolver();
      const result = await resolver.resolve('   ');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('malformed');
    });

    test('rejects random garbage input', async () => {
      const resolver = new InviteBasedResolver();
      const result = await resolver.resolve('not-a-valid-invite-code!!!');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('malformed');
    });

    test('rejects valid base64 with invalid JSON', async () => {
      const resolver = new InviteBasedResolver();
      const code = Buffer.from('this is not json').toString('base64url');
      const result = await resolver.resolve(code);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('malformed');
    });

    test('rejects JSON missing gateway field', async () => {
      const resolver = new InviteBasedResolver();
      const code = Buffer.from(JSON.stringify({ t: 'token', v: '1.0.0' })).toString('base64url');
      const result = await resolver.resolve(code);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('malformed');
    });

    test('rejects JSON missing token field', async () => {
      const resolver = new InviteBasedResolver();
      const code = Buffer.from(JSON.stringify({ g: 'https://example.com', v: '1.0.0' })).toString('base64url');
      const result = await resolver.resolve(code);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('malformed');
    });

    test('rejects JSON missing version field', async () => {
      const resolver = new InviteBasedResolver();
      const code = Buffer.from(JSON.stringify({ g: 'https://example.com', t: 'token' })).toString('base64url');
      const result = await resolver.resolve(code);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('malformed');
    });

    test('rejects JSON with empty string fields', async () => {
      const resolver = new InviteBasedResolver();
      const code = Buffer.from(JSON.stringify({ g: '', t: 'token', v: '1.0.0' })).toString('base64url');
      const result = await resolver.resolve(code);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('malformed');
    });

    test('rejects JSON with non-string fields', async () => {
      const resolver = new InviteBasedResolver();
      const code = Buffer.from(JSON.stringify({ g: 123, t: 'token', v: '1.0.0' })).toString('base64url');
      const result = await resolver.resolve(code);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('malformed');
    });
  });

  // ── Protocol version validation ───────────────────────────────────────

  describe('protocol version validation', () => {
    test('rejects incompatible major version (v2)', async () => {
      const resolver = new InviteBasedResolver();
      const payload = { g: PEER_GATEWAY_URL, t: 'token', v: '2.0.0' };
      const code = Buffer.from(JSON.stringify(payload)).toString('base64url');

      const result = await resolver.resolve(code);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('invalid_version');
    });

    test('rejects incompatible major version (v0)', async () => {
      const resolver = new InviteBasedResolver();
      const payload = { g: PEER_GATEWAY_URL, t: 'token', v: '0.9.0' };
      const code = Buffer.from(JSON.stringify(payload)).toString('base64url');

      const result = await resolver.resolve(code);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('invalid_version');
    });

    test('accepts compatible minor version difference', async () => {
      const resolver = new InviteBasedResolver();
      const payload = { g: PEER_GATEWAY_URL, t: 'token', v: '1.5.0' };
      const code = Buffer.from(JSON.stringify(payload)).toString('base64url');

      const result = await resolver.resolve(code);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.protocolVersion).toBe('1.5.0');
    });

    test('accepts compatible patch version difference', async () => {
      const resolver = new InviteBasedResolver();
      const payload = { g: PEER_GATEWAY_URL, t: 'token', v: '1.0.99' };
      const code = Buffer.from(JSON.stringify(payload)).toString('base64url');

      const result = await resolver.resolve(code);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.protocolVersion).toBe('1.0.99');
    });
  });

  // ── Target URL validation (via validateA2ATarget) ─────────────────────

  describe('target URL validation', () => {
    test('rejects HTTP for public addresses', async () => {
      const resolver = new InviteBasedResolver();
      const code = encodeInviteCode('http://public-peer.example.com', 'token');

      const result = await resolver.resolve(code);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('unreachable');
    });

    test('rejects runtime port 7821', async () => {
      const resolver = new InviteBasedResolver();
      const code = encodeInviteCode('https://peer.example.com:7821', 'token');

      const result = await resolver.resolve(code);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('unreachable');
    });

    test('rejects link-local addresses (169.254.x.x)', async () => {
      const resolver = new InviteBasedResolver();
      const code = encodeInviteCode('http://169.254.169.254/metadata', 'token');

      const result = await resolver.resolve(code);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('unreachable');
    });

    test('rejects self-loop when ownGatewayUrl is set', async () => {
      const resolver = new InviteBasedResolver({ ownGatewayUrl: MOCK_GATEWAY_URL });
      const code = encodeInviteCode(MOCK_GATEWAY_URL, 'token');

      const result = await resolver.resolve(code);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('unreachable');
    });

    test('accepts non-self gateway when ownGatewayUrl is set', async () => {
      const resolver = new InviteBasedResolver({ ownGatewayUrl: MOCK_GATEWAY_URL });
      const code = encodeInviteCode(PEER_GATEWAY_URL, 'token');

      const result = await resolver.resolve(code);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.peerGatewayUrl).toBe(PEER_GATEWAY_URL);
    });

    test('rejects non-HTTP(S) schemes encoded in invite', async () => {
      const resolver = new InviteBasedResolver();
      // Manually craft a payload with an ftp:// gateway URL
      const payload = { g: 'ftp://peer.example.com', t: 'token', v: A2A_PROTOCOL_VERSION };
      const code = Buffer.from(JSON.stringify(payload)).toString('base64url');

      const result = await resolver.resolve(code);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('unreachable');
    });
  });

  // ── Constructor options ───────────────────────────────────────────────

  describe('constructor options', () => {
    test('works without options', async () => {
      const resolver = new InviteBasedResolver();
      const code = encodeInviteCode(PEER_GATEWAY_URL, 'token');

      const result = await resolver.resolve(code);
      expect(result.ok).toBe(true);
    });

    test('works with empty options object', async () => {
      const resolver = new InviteBasedResolver({});
      const code = encodeInviteCode(PEER_GATEWAY_URL, 'token');

      const result = await resolver.resolve(code);
      expect(result.ok).toBe(true);
    });

    test('works with undefined ownGatewayUrl', async () => {
      const resolver = new InviteBasedResolver({ ownGatewayUrl: undefined });
      const code = encodeInviteCode(PEER_GATEWAY_URL, 'token');

      const result = await resolver.resolve(code);
      expect(result.ok).toBe(true);
    });
  });

  // ── Multiple resolvers (provider abstraction) ─────────────────────────

  describe('provider abstraction', () => {
    test('different resolver instances with different ownGatewayUrl behave independently', async () => {
      const resolver1 = new InviteBasedResolver({ ownGatewayUrl: MOCK_GATEWAY_URL });
      const resolver2 = new InviteBasedResolver({ ownGatewayUrl: PEER_GATEWAY_URL });

      const code1 = encodeInviteCode(MOCK_GATEWAY_URL, 'token');
      const code2 = encodeInviteCode(PEER_GATEWAY_URL, 'token');

      // resolver1 rejects MOCK_GATEWAY_URL (self-loop) but accepts PEER_GATEWAY_URL
      const r1a = await resolver1.resolve(code1);
      expect(r1a.ok).toBe(false);
      const r1b = await resolver1.resolve(code2);
      expect(r1b.ok).toBe(true);

      // resolver2 accepts MOCK_GATEWAY_URL but rejects PEER_GATEWAY_URL (self-loop)
      const r2a = await resolver2.resolve(code1);
      expect(r2a.ok).toBe(true);
      const r2b = await resolver2.resolve(code2);
      expect(r2b.ok).toBe(false);
    });

    test('resolver can be used as the PeerAddressResolver type', async () => {
      // Verifies the resolver works when typed through the interface
      const resolver: PeerAddressResolver = new InviteBasedResolver();
      const code = encodeInviteCode(PEER_GATEWAY_URL, 'token');

      const result = await resolver.resolve(code);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.peerGatewayUrl).toBe(PEER_GATEWAY_URL);
    });
  });
});
