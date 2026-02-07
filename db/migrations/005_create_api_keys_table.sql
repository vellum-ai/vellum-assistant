-- Create api_keys table for API key management
-- Scopes are stored as JSONB for flexibility in defining granular permissions
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  -- Store only the hash of the key for security (key shown once on creation)
  key_prefix VARCHAR(8) NOT NULL,  -- First 8 chars for identification (e.g., "velly_ab")
  key_hash VARCHAR(255) NOT NULL,
  -- Scopes define what the key can do
  -- Format: { "actions": ["read", "write", "delete"], "entities": ["agents", "messages"], "agent_ids": ["*"] }
  scopes JSONB NOT NULL DEFAULT '{"actions": ["read"], "entities": ["agents"], "agent_ids": ["*"]}',
  last_used_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys(key_prefix);
