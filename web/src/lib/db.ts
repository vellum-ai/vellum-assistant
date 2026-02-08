import { drizzle } from "drizzle-orm/postgres-js";
import { eq, and } from "drizzle-orm";
import postgres from "postgres";

import * as schema from "./schema";

// Database connection
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is not set");
}

// Raw SQL client for legacy queries
const sql = postgres(connectionString);

// Drizzle client for typed queries
export const db = drizzle(sql, { schema });

// Legacy compatibility - returns raw SQL client for template tag queries
// Usage: const sql = getDb(); await sql`SELECT * FROM assistants`;
export function getDb() {
  return sql;
}

// Re-export schema types
export type Assistant = typeof schema.assistantsTable.$inferSelect;
export type NewAssistant = typeof schema.assistantsTable.$inferInsert;
export type ChatMessage = typeof schema.chatMessagesTable.$inferSelect;
export type NewChatMessage = typeof schema.chatMessagesTable.$inferInsert;
export type User = typeof schema.usersTable.$inferSelect;
export type NewUser = typeof schema.usersTable.$inferInsert;
export type ApiKey = typeof schema.apiKeysTable.$inferSelect;
export type NewApiKey = typeof schema.apiKeysTable.$inferInsert;

// Legacy type aliases for backwards compatibility
export type Agent = Assistant;
export type NewAgent = NewAssistant;

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

// Legacy type aliases
export type CreateAgentInput = CreateAssistantInput;
export type UpdateAgentInput = UpdateAssistantInput;

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

// Legacy function aliases for backwards compatibility
export const getAgents = getAssistants;
export const getAgentById = getAssistantById;
export const createAgent = createAssistant;
export const updateAgent = updateAssistant;
export const deleteAgent = deleteAssistant;

// Chat message queries
export async function getChatMessages(assistantId: string) {
  return db
    .select()
    .from(schema.chatMessagesTable)
    .where(eq(schema.chatMessagesTable.assistantId, assistantId))
    .orderBy(schema.chatMessagesTable.createdAt);
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

// User queries
export async function getUserByUsername(username: string) {
  const result = await db.select().from(schema.usersTable).where(eq(schema.usersTable.username, username));
  return result[0] || null;
}

export async function createUser(data: NewUser) {
  const result = await db.insert(schema.usersTable).values(data).returning();
  return result[0];
}

export async function updateUser(username: string, data: Partial<NewUser>) {
  const result = await db
    .update(schema.usersTable)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(schema.usersTable.username, username))
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
