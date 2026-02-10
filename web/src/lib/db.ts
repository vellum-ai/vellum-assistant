import { drizzle } from "drizzle-orm/postgres-js";
import { eq, and, desc, isNull } from "drizzle-orm";
import postgres from "postgres";

import * as schema from "./schema";

// Database connection - lazily initialized to avoid build-time errors
let _sql: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function getConnectionString(): string {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is not set");
  }
  return connectionString;
}

function getSql(): ReturnType<typeof postgres> {
  if (!_sql) {
    _sql = postgres(getConnectionString());
  }
  return _sql;
}

function getOrCreateDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (!_db) {
    _db = drizzle(getSql(), { schema });
  }
  return _db;
}

// Drizzle client for typed queries
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop, receiver) {
    const realDb = getOrCreateDb();
    const value = Reflect.get(realDb, prop, receiver);
    if (typeof value === "function") {
      return value.bind(realDb);
    }
    return value;
  },
});

// Legacy compatibility - returns raw SQL client for template tag queries
// Usage: const sql = getDb(); await sql`SELECT * FROM assistants`;
export function getDb() {
  return getSql();
}

// Re-export schema types
export type Assistant = typeof schema.assistantsTable.$inferSelect;
export type NewAssistant = typeof schema.assistantsTable.$inferInsert;
export type ChatMessage = typeof schema.chatMessagesTable.$inferSelect;
export type NewChatMessage = typeof schema.chatMessagesTable.$inferInsert;
export type AssistantChannelAccount = typeof schema.assistantChannelAccountsTable.$inferSelect;
export type NewAssistantChannelAccount = typeof schema.assistantChannelAccountsTable.$inferInsert;
export type AssistantChannelContact = typeof schema.assistantChannelContactsTable.$inferSelect;
export type NewAssistantChannelContact = typeof schema.assistantChannelContactsTable.$inferInsert;
export type User = typeof schema.user.$inferSelect;
export type NewUser = typeof schema.user.$inferInsert;
export type ApiKey = typeof schema.apiKeysTable.$inferSelect;
export type NewApiKey = typeof schema.apiKeysTable.$inferInsert;


// API input types
export type CreateAssistantInput = {
  name?: string;
  description?: string;
  configuration?: Record<string, unknown>;
  assistant_type?: string;
};

export type UpdateAssistantInput = {
  name?: string;
  description?: string;
  configuration?: Record<string, unknown>;
};


// Assistant queries
export async function getAssistants() {
  return db.select().from(schema.assistantsTable);
}

export async function getAssistantById(id: string) {
  const result = await db.select().from(schema.assistantsTable).where(eq(schema.assistantsTable.id, id));
  return result[0] || null;
}

export async function createAssistant(data: NewAssistant) {
  const result = await db.insert(schema.assistantsTable).values(data).returning();
  return result[0];
}

export async function updateAssistant(id: string, data: Partial<NewAssistant>) {
  const result = await db
    .update(schema.assistantsTable)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(schema.assistantsTable.id, id))
    .returning();
  return result[0];
}

export async function deleteAssistant(id: string) {
  await db.delete(schema.assistantsTable).where(eq(schema.assistantsTable.id, id));
}


// Chat message queries
export async function getChatMessages(assistantId: string) {
  return db
    .select()
    .from(schema.chatMessagesTable)
    .where(eq(schema.chatMessagesTable.assistantId, assistantId))
    .orderBy(schema.chatMessagesTable.createdAt);
}

export async function getRecentChatMessages(assistantId: string, limit = 40) {
  const messages = await db
    .select()
    .from(schema.chatMessagesTable)
    .where(eq(schema.chatMessagesTable.assistantId, assistantId))
    .orderBy(desc(schema.chatMessagesTable.createdAt))
    .limit(limit);
  return [...messages].reverse();
}

export async function getRecentConversationMessages(params: {
  assistantId: string;
  sourceChannel: string;
  externalChatId: string;
  limit?: number;
}) {
  const limit = params.limit ?? 40;
  const messages = await db
    .select()
    .from(schema.chatMessagesTable)
    .where(
      and(
        eq(schema.chatMessagesTable.assistantId, params.assistantId),
        eq(schema.chatMessagesTable.sourceChannel, params.sourceChannel),
        eq(schema.chatMessagesTable.externalChatId, params.externalChatId)
      )
    )
    .orderBy(desc(schema.chatMessagesTable.createdAt))
    .limit(limit);

  return [...messages].reverse();
}

export async function createChatMessage(data: NewChatMessage) {
  const result = await db.insert(schema.chatMessagesTable).values(data).returning();
  return result[0];
}

export async function updateChatMessageStatus(id: string, status: string) {
  await db
    .update(schema.chatMessagesTable)
    .set({ status, updatedAt: new Date() })
    .where(eq(schema.chatMessagesTable.id, id));
}

export async function getMessageByGcsId(gcsMessageId: string) {
  const result = await db
    .select()
    .from(schema.chatMessagesTable)
    .where(eq(schema.chatMessagesTable.gcsMessageId, gcsMessageId));
  return result[0] || null;
}

export async function getMessageByExternalId(
  assistantId: string,
  sourceChannel: string,
  externalChatId: string | null | undefined,
  externalMessageId: string
) {
  const chatMatch = externalChatId
    ? eq(schema.chatMessagesTable.externalChatId, externalChatId)
    : isNull(schema.chatMessagesTable.externalChatId);

  const result = await db
    .select()
    .from(schema.chatMessagesTable)
    .where(
      and(
        eq(schema.chatMessagesTable.assistantId, assistantId),
        eq(schema.chatMessagesTable.sourceChannel, sourceChannel),
        chatMatch,
        eq(schema.chatMessagesTable.externalMessageId, externalMessageId)
      )
    );
  return result[0] || null;
}

// User queries
export async function getUserByUsername(username: string) {
  const result = await db.select().from(schema.user).where(eq(schema.user.username, username));
  return result[0] || null;
}

export async function createUser(data: NewUser) {
  const result = await db.insert(schema.user).values(data).returning();
  return result[0];
}

export async function updateUser(username: string, data: Partial<NewUser>) {
  const result = await db
    .update(schema.user)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(schema.user.username, username))
    .returning();
  return result[0];
}

// API Key queries
export async function getApiKeysByUserId(userId: string) {
  return db.select().from(schema.apiKeysTable).where(eq(schema.apiKeysTable.userId, userId));
}

export async function createApiKey(data: NewApiKey) {
  const result = await db.insert(schema.apiKeysTable).values(data).returning();
  return result[0];
}

export async function deleteApiKey(id: string, userId: string) {
  await db
    .delete(schema.apiKeysTable)
    .where(and(eq(schema.apiKeysTable.id, id), eq(schema.apiKeysTable.userId, userId)));
}
