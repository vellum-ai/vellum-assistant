import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
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
// Usage: const sql = getDb(); await sql`SELECT * FROM agents`;
export function getDb() {
  return sql;
}

// Re-export schema types
export type Assistant = typeof schema.assistants.$inferSelect;
export type NewAssistant = typeof schema.assistants.$inferInsert;
export type ChatMessage = typeof schema.chatMessages.$inferSelect;
export type NewChatMessage = typeof schema.chatMessages.$inferInsert;
export type User = typeof schema.users.$inferSelect;
export type NewUser = typeof schema.users.$inferInsert;
export type ApiKey = typeof schema.apiKeys.$inferSelect;
export type NewApiKey = typeof schema.apiKeys.$inferInsert;

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
  return db.select().from(schema.assistants);
}

export async function getAssistantById(id: string) {
  const result = await db.select().from(schema.assistants).where(eq(schema.assistants.id, id));
  return result[0] || null;
}

export async function createAssistant(data: NewAssistant) {
  const result = await db.insert(schema.assistants).values(data).returning();
  return result[0];
}

export async function updateAssistant(id: string, data: Partial<NewAssistant>) {
  const result = await db
    .update(schema.assistants)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(schema.assistants.id, id))
    .returning();
  return result[0];
}

export async function deleteAssistant(id: string) {
  await db.delete(schema.assistants).where(eq(schema.assistants.id, id));
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
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.assistantId, assistantId))
    .orderBy(schema.chatMessages.createdAt);
}

export async function createChatMessage(data: NewChatMessage) {
  const result = await db.insert(schema.chatMessages).values(data).returning();
  return result[0];
}

export async function updateChatMessageStatus(id: string, status: string) {
  await db
    .update(schema.chatMessages)
    .set({ status, updatedAt: new Date() })
    .where(eq(schema.chatMessages.id, id));
}

export async function getMessageByGcsId(gcsMessageId: string) {
  const result = await db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.gcsMessageId, gcsMessageId));
  return result[0] || null;
}

// User queries
export async function getUserByUsername(username: string) {
  const result = await db.select().from(schema.users).where(eq(schema.users.username, username));
  return result[0] || null;
}

export async function createUser(data: NewUser) {
  const result = await db.insert(schema.users).values(data).returning();
  return result[0];
}

export async function updateUser(username: string, data: Partial<NewUser>) {
  const result = await db
    .update(schema.users)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(schema.users.username, username))
    .returning();
  return result[0];
}

// API Key queries
export async function getApiKeysByUserId(userId: string) {
  return db.select().from(schema.apiKeys).where(eq(schema.apiKeys.userId, userId));
}

export async function createApiKey(data: NewApiKey) {
  const result = await db.insert(schema.apiKeys).values(data).returning();
  return result[0];
}

export async function deleteApiKey(id: string, _userId: string) {
  await db
    .delete(schema.apiKeys)
    .where(eq(schema.apiKeys.id, id));
}
