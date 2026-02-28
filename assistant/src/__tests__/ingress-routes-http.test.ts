import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'ingress-routes-http-test-'));

mock.module('../util/platform.js', () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

import { getSqlite, initializeDb, resetDb } from '../memory/db.js';
import {
  handleBlockMember,
  handleCreateInvite,
  handleListInvites,
  handleListMembers,
  handleRedeemInvite,
  handleRevokeInvite,
  handleRevokeMember,
  handleUpsertMember,
} from '../runtime/routes/ingress-routes.js';

initializeDb();

afterAll(() => {
  resetDb();
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

function resetTables() {
  getSqlite().run('DELETE FROM assistant_ingress_members');
  getSqlite().run('DELETE FROM assistant_ingress_invites');
}

// ---------------------------------------------------------------------------
// Member routes
// ---------------------------------------------------------------------------

describe('ingress member HTTP routes', () => {
  beforeEach(resetTables);

  test('POST /v1/ingress/members — upsert creates a member', async () => {
    const req = new Request('http://localhost/v1/ingress/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceChannel: 'telegram',
        externalUserId: 'user-1',
        displayName: 'Test User',
        policy: 'allow',
        status: 'active',
      }),
    });

    const res = await handleUpsertMember(req);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.member).toBeDefined();
    const member = body.member as Record<string, unknown>;
    expect(member.sourceChannel).toBe('telegram');
    expect(member.externalUserId).toBe('user-1');
    expect(member.displayName).toBe('Test User');
    expect(member.policy).toBe('allow');
    expect(member.status).toBe('active');
  });

  test('POST /v1/ingress/members — missing sourceChannel returns 400', async () => {
    const req = new Request('http://localhost/v1/ingress/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        externalUserId: 'user-1',
      }),
    });

    const res = await handleUpsertMember(req);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.message).toContain('sourceChannel');
  });

  test('POST /v1/ingress/members — missing identity returns 400', async () => {
    const req = new Request('http://localhost/v1/ingress/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceChannel: 'telegram',
      }),
    });

    const res = await handleUpsertMember(req);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.message).toContain('externalUserId');
  });

  test('GET /v1/ingress/members — lists members', async () => {
    // Create two members
    await handleUpsertMember(new Request('http://localhost/v1/ingress/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceChannel: 'telegram', externalUserId: 'user-1', status: 'active' }),
    }));
    await handleUpsertMember(new Request('http://localhost/v1/ingress/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceChannel: 'telegram', externalUserId: 'user-2', status: 'active' }),
    }));

    const url = new URL('http://localhost/v1/ingress/members');
    const res = handleListMembers(url);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.members)).toBe(true);
    expect((body.members as unknown[]).length).toBe(2);
  });

  test('GET /v1/ingress/members — filters by sourceChannel', async () => {
    await handleUpsertMember(new Request('http://localhost/v1/ingress/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceChannel: 'telegram', externalUserId: 'user-1', status: 'active' }),
    }));
    await handleUpsertMember(new Request('http://localhost/v1/ingress/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceChannel: 'sms', externalUserId: 'user-2', status: 'active' }),
    }));

    const url = new URL('http://localhost/v1/ingress/members?sourceChannel=telegram');
    const res = handleListMembers(url);
    const body = await res.json() as Record<string, unknown>;

    expect((body.members as unknown[]).length).toBe(1);
  });

  test('DELETE /v1/ingress/members/:id — revokes a member', async () => {
    const createRes = await handleUpsertMember(new Request('http://localhost/v1/ingress/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceChannel: 'telegram', externalUserId: 'user-1', status: 'active' }),
    }));
    const created = await createRes.json() as { member: { id: string } };

    const req = new Request('http://localhost/v1/ingress/members/' + created.member.id, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'test revoke' }),
    });
    const res = await handleRevokeMember(req, created.member.id);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const member = body.member as Record<string, unknown>;
    expect(member.status).toBe('revoked');
  });

  test('DELETE /v1/ingress/members/:id — not found returns 404', async () => {
    const req = new Request('http://localhost/v1/ingress/members/nonexistent', {
      method: 'DELETE',
    });
    const res = await handleRevokeMember(req, 'nonexistent');
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
  });

  test('POST /v1/ingress/members/:id/block — blocks a member', async () => {
    const createRes = await handleUpsertMember(new Request('http://localhost/v1/ingress/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceChannel: 'telegram', externalUserId: 'user-1', status: 'active' }),
    }));
    const created = await createRes.json() as { member: { id: string } };

    const req = new Request('http://localhost/v1/ingress/members/' + created.member.id + '/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'spam' }),
    });
    const res = await handleBlockMember(req, created.member.id);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const member = body.member as Record<string, unknown>;
    expect(member.status).toBe('blocked');
  });

  test('POST /v1/ingress/members/:id/block — already blocked returns 404', async () => {
    const createRes = await handleUpsertMember(new Request('http://localhost/v1/ingress/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceChannel: 'telegram', externalUserId: 'user-1', status: 'active' }),
    }));
    const created = await createRes.json() as { member: { id: string } };

    // Block first time
    await handleBlockMember(
      new Request('http://localhost/block', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      created.member.id,
    );

    // Block second time
    const req = new Request('http://localhost/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await handleBlockMember(req, created.member.id);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invite routes
// ---------------------------------------------------------------------------

describe('ingress invite HTTP routes', () => {
  beforeEach(resetTables);

  test('POST /v1/ingress/invites — creates an invite', async () => {
    const req = new Request('http://localhost/v1/ingress/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceChannel: 'telegram',
        note: 'Test invite',
        maxUses: 5,
      }),
    });

    const res = await handleCreateInvite(req);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
    const invite = body.invite as Record<string, unknown>;
    expect(invite.sourceChannel).toBe('telegram');
    expect(invite.note).toBe('Test invite');
    expect(invite.maxUses).toBe(5);
    expect(invite.status).toBe('active');
    // Raw token should be returned on create
    expect(typeof invite.token).toBe('string');
    expect((invite.token as string).length).toBeGreaterThan(0);
  });

  test('POST /v1/ingress/invites — includes canonical share URL when bot username is configured', async () => {
    const prevBotUsername = process.env.TELEGRAM_BOT_USERNAME;
    process.env.TELEGRAM_BOT_USERNAME = 'test_invite_bot';

    try {
      const req = new Request('http://localhost/v1/ingress/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceChannel: 'telegram',
          note: 'Share link test',
        }),
      });

      const res = await handleCreateInvite(req);
      const body = await res.json() as Record<string, unknown>;
      const invite = body.invite as Record<string, unknown>;
      const token = invite.token as string;
      const share = invite.share as Record<string, unknown>;

      expect(res.status).toBe(201);
      expect(body.ok).toBe(true);
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
      expect(share).toBeDefined();
      expect(share.url).toBe(`https://t.me/test_invite_bot?start=iv_${token}`);
      expect(typeof share.displayText).toBe('string');
    } finally {
      if (prevBotUsername === undefined) {
        delete process.env.TELEGRAM_BOT_USERNAME;
      } else {
        process.env.TELEGRAM_BOT_USERNAME = prevBotUsername;
      }
    }
  });

  test('POST /v1/ingress/invites — missing sourceChannel returns 400', async () => {
    const req = new Request('http://localhost/v1/ingress/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'No channel' }),
    });

    const res = await handleCreateInvite(req);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.message).toContain('sourceChannel');
  });

  test('GET /v1/ingress/invites — lists invites', async () => {
    // Create two invites
    await handleCreateInvite(new Request('http://localhost/v1/ingress/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceChannel: 'telegram' }),
    }));
    await handleCreateInvite(new Request('http://localhost/v1/ingress/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceChannel: 'telegram' }),
    }));

    const url = new URL('http://localhost/v1/ingress/invites');
    const res = handleListInvites(url);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.invites)).toBe(true);
    expect((body.invites as unknown[]).length).toBe(2);
  });

  test('DELETE /v1/ingress/invites/:id — revokes an invite', async () => {
    const createRes = await handleCreateInvite(new Request('http://localhost/v1/ingress/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceChannel: 'telegram' }),
    }));
    const created = await createRes.json() as { invite: { id: string } };

    const res = handleRevokeInvite(created.invite.id);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const invite = body.invite as Record<string, unknown>;
    expect(invite.status).toBe('revoked');
  });

  test('DELETE /v1/ingress/invites/:id — not found returns 404', () => {
    const res = handleRevokeInvite('nonexistent-id');
    expect(res.status).toBe(404);
  });

  test('POST /v1/ingress/invites/redeem — redeems an invite', async () => {
    // Create an invite first
    const createRes = await handleCreateInvite(new Request('http://localhost/v1/ingress/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceChannel: 'telegram', maxUses: 1 }),
    }));
    const created = await createRes.json() as { invite: { token: string } };

    const req = new Request('http://localhost/v1/ingress/invites/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: created.invite.token,
        externalUserId: 'redeemer-1',
        sourceChannel: 'telegram',
      }),
    });

    const res = await handleRedeemInvite(req);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const invite = body.invite as Record<string, unknown>;
    expect(invite.useCount).toBe(1);
    // Single-use invite should be fully redeemed
    expect(invite.status).toBe('redeemed');
  });

  test('POST /v1/ingress/invites/redeem — missing token returns 400', async () => {
    const req = new Request('http://localhost/v1/ingress/invites/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ externalUserId: 'redeemer-1' }),
    });

    const res = await handleRedeemInvite(req);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.message).toContain('token');
  });

  test('POST /v1/ingress/invites/redeem — invalid token returns 400', async () => {
    const req = new Request('http://localhost/v1/ingress/invites/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'invalid-token' }),
    });

    const res = await handleRedeemInvite(req);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IPC backward compatibility — shared logic produces same results
// ---------------------------------------------------------------------------

describe('ingress service shared logic', () => {
  beforeEach(resetTables);

  test('member upsert + list round-trip through shared service', async () => {
    const createRes = await handleUpsertMember(new Request('http://localhost/v1/ingress/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceChannel: 'telegram',
        externalUserId: 'user-rt',
        displayName: 'Round Trip',
        policy: 'allow',
        status: 'active',
      }),
    }));
    const created = await createRes.json() as { member: { id: string; displayName: string } };
    expect(created.member.displayName).toBe('Round Trip');

    const listRes = handleListMembers(new URL('http://localhost/v1/ingress/members'));
    const listed = await listRes.json() as { members: Array<{ id: string; displayName: string }> };
    expect(listed.members.length).toBe(1);
    expect(listed.members[0].id).toBe(created.member.id);
  });

  test('invite create + revoke round-trip through shared service', async () => {
    const createRes = await handleCreateInvite(new Request('http://localhost/v1/ingress/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceChannel: 'telegram' }),
    }));
    const created = await createRes.json() as { invite: { id: string; status: string } };
    expect(created.invite.status).toBe('active');

    const revokeRes = handleRevokeInvite(created.invite.id);
    const revoked = await revokeRes.json() as { invite: { id: string; status: string } };
    expect(revoked.invite.status).toBe('revoked');
    expect(revoked.invite.id).toBe(created.invite.id);
  });
});

// ---------------------------------------------------------------------------
// Voice invite routes
// ---------------------------------------------------------------------------

describe('voice invite HTTP routes', () => {
  beforeEach(resetTables);

  test('POST /v1/ingress/invites with sourceChannel voice — creates invite with voiceCode, stores hash only', async () => {
    const req = new Request('http://localhost/v1/ingress/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceChannel: 'voice',
        expectedExternalUserId: '+15551234567',
        maxUses: 3,
      }),
    });

    const res = await handleCreateInvite(req);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
    const invite = body.invite as Record<string, unknown>;
    expect(invite.sourceChannel).toBe('voice');
    // Voice code should be returned (6 digits by default)
    expect(typeof invite.voiceCode).toBe('string');
    expect((invite.voiceCode as string).length).toBe(6);
    expect(/^\d{6}$/.test(invite.voiceCode as string)).toBe(true);
    // Hash should be stored
    expect(typeof invite.tokenHash).toBe('string');
    expect((invite.tokenHash as string).length).toBeGreaterThan(0);
    // voiceCodeDigits should be recorded
    expect(invite.voiceCodeDigits).toBe(6);
    // expectedExternalUserId should be recorded
    expect(invite.expectedExternalUserId).toBe('+15551234567');
  });

  test('voice invite creation requires expectedExternalUserId', async () => {
    const req = new Request('http://localhost/v1/ingress/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceChannel: 'voice',
      }),
    });

    const res = await handleCreateInvite(req);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('expectedExternalUserId');
  });

  test('voice invite creation validates E.164 format', async () => {
    const req = new Request('http://localhost/v1/ingress/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceChannel: 'voice',
        expectedExternalUserId: 'not-a-phone-number',
      }),
    });

    const res = await handleCreateInvite(req);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('E.164');
  });

  test('voiceCodeDigits is always 6 — custom values are ignored', async () => {
    const req = new Request('http://localhost/v1/ingress/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceChannel: 'voice',
        expectedExternalUserId: '+15551234567',
        voiceCodeDigits: 8,
      }),
    });

    const res = await handleCreateInvite(req);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
    const invite = body.invite as Record<string, unknown>;
    expect((invite.voiceCode as string).length).toBe(6);
    expect(invite.voiceCodeDigits).toBe(6);
  });

  test('voice invites do NOT return token in response', async () => {
    const req = new Request('http://localhost/v1/ingress/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceChannel: 'voice',
        expectedExternalUserId: '+15551234567',
      }),
    });

    const res = await handleCreateInvite(req);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(201);
    const invite = body.invite as Record<string, unknown>;
    // Voice invites must not expose the raw token — callers redeem via
    // the identity-bound voice code flow
    expect(invite.token).toBeUndefined();
  });

  test('POST /v1/ingress/invites/redeem — redeems a voice invite code via unified endpoint', async () => {
    // Create a voice invite
    const createRes = await handleCreateInvite(new Request('http://localhost/v1/ingress/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceChannel: 'voice',
        expectedExternalUserId: '+15551234567',
        maxUses: 1,
      }),
    }));
    const created = await createRes.json() as { invite: { voiceCode: string } };

    // Redeem the voice code via the unified /redeem endpoint
    const redeemReq = new Request('http://localhost/v1/ingress/invites/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callerExternalUserId: '+15551234567',
        code: created.invite.voiceCode,
      }),
    });

    const res = await handleRedeemInvite(redeemReq);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.type).toBe('redeemed');
    expect(typeof body.memberId).toBe('string');
    expect(typeof body.inviteId).toBe('string');
  });

  test('POST /v1/ingress/invites/redeem — voice code missing fields returns 400', async () => {
    const req = new Request('http://localhost/v1/ingress/invites/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callerExternalUserId: '+15551234567' }),
    });

    const res = await handleRedeemInvite(req);
    const body = await res.json() as Record<string, unknown>;

    // No `code` and no `token` → falls through to token-based path which requires token
    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
  });

  test('POST /v1/ingress/invites/redeem — wrong voice code returns 400', async () => {
    // Create a voice invite
    await handleCreateInvite(new Request('http://localhost/v1/ingress/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceChannel: 'voice',
        expectedExternalUserId: '+15551234567',
        maxUses: 1,
      }),
    }));

    const req = new Request('http://localhost/v1/ingress/invites/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callerExternalUserId: '+15551234567',
        code: '000000',
      }),
    });

    const res = await handleRedeemInvite(req);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
  });
});
