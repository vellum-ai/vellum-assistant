-- Rename agents table to assistants
ALTER TABLE "agents" RENAME TO "assistants";

-- Rename the column in chat_messages table
ALTER TABLE "chat_messages" RENAME COLUMN "agent_id" TO "assistant_id";

-- Drop the old index
DROP INDEX IF EXISTS "idx_chat_messages_agent_id";

-- Create the new index
CREATE INDEX IF NOT EXISTS "idx_chat_messages_assistant_id" ON "chat_messages" ("assistant_id");

-- Update the foreign key constraint name (PostgreSQL will handle the reference automatically)
-- The foreign key will continue to work after the table rename
