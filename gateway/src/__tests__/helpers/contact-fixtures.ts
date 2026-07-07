/**
 * Shared contact / invite seed fixtures for gateway DB-backed suites.
 *
 * All DB access is deferred to call time (via `getGatewayDb()`), so importing
 * this module has no side effects. Suites that mock DB-adjacent modules must
 * still import this helper *after* their `mock.module` calls (i.e. via the same
 * dynamic `await import` they use for `db/*`).
 */
import { hashInviteCode, hashInviteToken } from "@vellumai/gateway-client";

import { getGatewayDb } from "../../db/connection.js";
import { ContactStore } from "../../db/contact-store.js";
import { actorTokenRecords, contacts } from "../../db/schema.js";

const INVITE_CODE = "123456";
const INVITE_TOKEN = "tok_raw_abc123";
const INVITE_CHANNEL = "telegram";
const VOICE_CALLER = "+15555550100";

type CreateInviteInput = Parameters<
  InstanceType<typeof ContactStore>["createInvite"]
>[0];

/** Insert a contact row; unspecified fields fall back to `name-<id>`/contact/null. */
export function seedContact(opts: {
  id: string;
  displayName?: string;
  role?: string;
  principalId?: string | null;
  createdAt?: number;
  updatedAt?: number;
}): void {
  const now = opts.createdAt ?? Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id: opts.id,
      displayName: opts.displayName ?? `name-${opts.id}`,
      role: opts.role ?? "contact",
      principalId: opts.principalId ?? null,
      createdAt: now,
      updatedAt: opts.updatedAt ?? now,
    })
    .run();
}

/** Insert an active actor-token row bound to a guardian principal. */
export function seedActorToken(opts: { id?: string } = {}): void {
  const now = Date.now();
  getGatewayDb()
    .insert(actorTokenRecords)
    .values({
      id: opts.id ?? crypto.randomUUID(),
      tokenHash: "hash-1",
      guardianPrincipalId: "principal-123",
      hashedDeviceId: "device-abc",
      platform: "macos",
      status: "active",
      issuedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/** Look up an invite row by id, asserting it exists. */
export function inviteRow(id: string) {
  return new ContactStore().getInviteById(id)!;
}

/** Seed a code+token text invite (defaults to the telegram channel). */
export function seedInvite(overrides: Partial<CreateInviteInput> = {}): string {
  const id = overrides.id ?? crypto.randomUUID();
  new ContactStore().createInvite({
    id,
    sourceChannel: INVITE_CHANNEL,
    inviteCodeHash: hashInviteCode(INVITE_CODE),
    tokenHash: hashInviteToken(INVITE_TOKEN),
    contactId: "c1",
    maxUses: 1,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  });
  return id;
}

/** Seed a voice (phone-channel) invite bound to `VOICE_CALLER`. */
export function seedVoiceInvite(
  overrides: Partial<CreateInviteInput> = {},
): string {
  const id = overrides.id ?? crypto.randomUUID();
  new ContactStore().createInvite({
    id,
    sourceChannel: "phone",
    voiceCodeHash: hashInviteCode(INVITE_CODE),
    voiceCodeDigits: 6,
    expectedExternalUserId: VOICE_CALLER,
    friendName: "Friend Name",
    guardianName: "Guardian Name",
    contactId: "c1",
    maxUses: 1,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  });
  return id;
}
