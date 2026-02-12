import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { getDb } from './db.js';
import { accounts } from './schema.js';

export interface AccountRecord {
  id: string;
  service: string;
  username: string | null;
  email: string | null;
  displayName: string | null;
  status: string;
  credentialRef: string | null;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
}

export function createAccount(params: {
  service: string;
  username?: string;
  email?: string;
  displayName?: string;
  status?: string;
  credentialRef?: string;
  metadata?: Record<string, unknown>;
}): AccountRecord {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();

  const record = {
    id,
    service: params.service,
    username: params.username ?? null,
    email: params.email ?? null,
    displayName: params.displayName ?? null,
    status: params.status ?? 'active',
    credentialRef: params.credentialRef ?? null,
    metadataJson: params.metadata ? JSON.stringify(params.metadata) : null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(accounts).values(record).run();
  return record;
}

export function listAccounts(filters?: {
  service?: string;
  status?: string;
}): AccountRecord[] {
  const db = getDb();

  const conditions = [];
  if (filters?.service) {
    conditions.push(eq(accounts.service, filters.service));
  }
  if (filters?.status) {
    conditions.push(eq(accounts.status, filters.status));
  }

  if (conditions.length === 0) {
    return db.select().from(accounts).all();
  }
  if (conditions.length === 1) {
    return db.select().from(accounts).where(conditions[0]).all();
  }
  return db.select().from(accounts).where(and(...conditions)).all();
}

export function getAccount(id: string): AccountRecord | undefined {
  const db = getDb();
  const rows = db.select().from(accounts).where(eq(accounts.id, id)).all();
  return rows[0] ?? undefined;
}

export function updateAccount(
  id: string,
  updates: {
    service?: string;
    username?: string;
    email?: string;
    displayName?: string;
    status?: string;
    credentialRef?: string;
    metadata?: Record<string, unknown>;
  },
): AccountRecord | undefined {
  const existing = getAccount(id);
  if (!existing) return undefined;

  const now = Date.now();
  const values: Record<string, unknown> = { updatedAt: now };

  if (updates.service !== undefined) values.service = updates.service;
  if (updates.username !== undefined) values.username = updates.username;
  if (updates.email !== undefined) values.email = updates.email;
  if (updates.displayName !== undefined) values.displayName = updates.displayName;
  if (updates.status !== undefined) values.status = updates.status;
  if (updates.credentialRef !== undefined) values.credentialRef = updates.credentialRef;
  if (updates.metadata !== undefined) values.metadataJson = JSON.stringify(updates.metadata);

  const db = getDb();
  db.update(accounts).set(values).where(eq(accounts.id, id)).run();

  return getAccount(id);
}
