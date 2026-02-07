import { neon } from "@neondatabase/serverless";

export function getDb() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is not set");
  }
  return neon(databaseUrl);
}

export async function initializeDatabase() {
  const sql = getDb();

  await sql`
    CREATE TABLE IF NOT EXISTS agents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      description TEXT,
      configuration JSONB DEFAULT '{}',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `;
}

export interface Agent {
  id: string;
  name: string;
  description: string | null;
  configuration: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  configuration?: Record<string, unknown>;
  agent_type?: string;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  configuration?: Record<string, unknown>;
}

export type MessageRole = "user" | "assistant";
export type MessageStatus = "pending" | "sent" | "delivered" | "read";

export interface ChatMessage {
  id: string;
  agent_id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  gcs_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateChatMessageInput {
  agent_id: string;
  role: MessageRole;
  content: string;
  status?: MessageStatus;
  gcs_message_id?: string;
}

export async function initializeMessagesTable() {
  const sql = getDb();

  await sql`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL,
      content TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'sent',
      gcs_message_id VARCHAR(255),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_id ON chat_messages(agent_id)
  `;
}

export async function getChatMessages(agentId: string): Promise<ChatMessage[]> {
  const sql = getDb();
  const messages = await sql`
    SELECT * FROM chat_messages 
    WHERE agent_id = ${agentId} 
    ORDER BY created_at ASC
  `;
  return messages as ChatMessage[];
}

export async function createChatMessage(input: CreateChatMessageInput): Promise<ChatMessage> {
  const sql = getDb();
  const result = await sql`
    INSERT INTO chat_messages (agent_id, role, content, status, gcs_message_id)
    VALUES (
      ${input.agent_id}, 
      ${input.role}, 
      ${input.content}, 
      ${input.status || "sent"}, 
      ${input.gcs_message_id || null}
    )
    RETURNING *
  `;
  return result[0] as ChatMessage;
}

export async function updateChatMessageStatus(
  messageId: string,
  status: MessageStatus
): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE chat_messages 
    SET status = ${status}, updated_at = NOW() 
    WHERE id = ${messageId}
  `;
}

export async function getMessageByGcsId(gcsMessageId: string): Promise<ChatMessage | null> {
  const sql = getDb();
  const result = await sql`
    SELECT * FROM chat_messages WHERE gcs_message_id = ${gcsMessageId}
  `;
  return result.length > 0 ? (result[0] as ChatMessage) : null;
}
