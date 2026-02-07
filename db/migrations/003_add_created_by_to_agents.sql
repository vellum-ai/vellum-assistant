-- Migration: Add created_by column to agents table
-- Created: 2026-02-06

ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_by VARCHAR(255);
