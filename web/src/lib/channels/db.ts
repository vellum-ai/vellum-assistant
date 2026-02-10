import { getDb } from "@/lib/db";

export type AssistantChannelAccountRecord = {
  id: string;
  assistant_id: string;
  channel: string;
  account_key: string;
  enabled: boolean;
  status: string;
  config: Record<string, unknown>;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type AssistantChannelContactStatus = "pending" | "approved" | "blocked";

export type AssistantChannelContactRecord = {
  id: string;
  assistant_channel_account_id: string;
  external_user_id: string;
  external_chat_id: string;
  username: string | null;
  display_name: string | null;
  status: AssistantChannelContactStatus;
  last_pairing_prompt_at: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function getAssistantChannelAccountById(
  channelAccountId: string
): Promise<AssistantChannelAccountRecord | null> {
  const sql = getDb();
  const result = await sql`
    SELECT *
    FROM assistant_channel_accounts
    WHERE id = ${channelAccountId}
    LIMIT 1
  `;
  return (result[0] as AssistantChannelAccountRecord | undefined) ?? null;
}

export async function getAssistantChannelAccount(
  assistantId: string,
  channel: string,
  accountKey = "default"
): Promise<AssistantChannelAccountRecord | null> {
  const sql = getDb();
  const result = await sql`
    SELECT *
    FROM assistant_channel_accounts
    WHERE assistant_id = ${assistantId}
      AND channel = ${channel}
      AND account_key = ${accountKey}
    LIMIT 1
  `;
  return (result[0] as AssistantChannelAccountRecord | undefined) ?? null;
}

export async function listAssistantChannelAccounts(
  assistantId: string
): Promise<AssistantChannelAccountRecord[]> {
  const sql = getDb();
  const result = await sql`
    SELECT *
    FROM assistant_channel_accounts
    WHERE assistant_id = ${assistantId}
    ORDER BY created_at ASC
  `;
  return result as unknown as AssistantChannelAccountRecord[];
}

export async function upsertAssistantChannelAccount(params: {
  assistantId: string;
  channel: string;
  accountKey?: string;
  enabled: boolean;
  status: string;
  config: Record<string, unknown>;
  lastError?: string | null;
}): Promise<AssistantChannelAccountRecord> {
  const sql = getDb();
  const accountKey = params.accountKey ?? "default";

  const result = await sql`
    INSERT INTO assistant_channel_accounts (
      assistant_id,
      channel,
      account_key,
      enabled,
      status,
      config,
      last_error
    )
    VALUES (
      ${params.assistantId},
      ${params.channel},
      ${accountKey},
      ${params.enabled},
      ${params.status},
      ${JSON.stringify(params.config)},
      ${params.lastError ?? null}
    )
    ON CONFLICT (assistant_id, channel, account_key)
    DO UPDATE SET
      enabled = EXCLUDED.enabled,
      status = EXCLUDED.status,
      config = EXCLUDED.config,
      last_error = EXCLUDED.last_error,
      updated_at = NOW()
    RETURNING *
  `;

  return result[0] as AssistantChannelAccountRecord;
}

export async function deleteAssistantChannelAccount(
  channelAccountId: string
): Promise<void> {
  const sql = getDb();
  await sql`
    DELETE FROM assistant_channel_accounts
    WHERE id = ${channelAccountId}
  `;
}

export async function getAssistantChannelContactById(
  contactId: string
): Promise<AssistantChannelContactRecord | null> {
  const sql = getDb();
  const result = await sql`
    SELECT *
    FROM assistant_channel_contacts
    WHERE id = ${contactId}
    LIMIT 1
  `;
  return (result[0] as AssistantChannelContactRecord | undefined) ?? null;
}

export async function getAssistantChannelContactByExternalUser(params: {
  channelAccountId: string;
  externalUserId: string;
}): Promise<AssistantChannelContactRecord | null> {
  const sql = getDb();
  const result = await sql`
    SELECT *
    FROM assistant_channel_contacts
    WHERE assistant_channel_account_id = ${params.channelAccountId}
      AND external_user_id = ${params.externalUserId}
    LIMIT 1
  `;
  return (result[0] as AssistantChannelContactRecord | undefined) ?? null;
}

export async function listAssistantChannelContacts(params: {
  channelAccountId: string;
  status?: AssistantChannelContactStatus;
}): Promise<AssistantChannelContactRecord[]> {
  const sql = getDb();
  const result = params.status
    ? await sql`
        SELECT *
        FROM assistant_channel_contacts
        WHERE assistant_channel_account_id = ${params.channelAccountId}
          AND status = ${params.status}
        ORDER BY last_seen_at DESC NULLS LAST, created_at DESC
      `
    : await sql`
        SELECT *
        FROM assistant_channel_contacts
        WHERE assistant_channel_account_id = ${params.channelAccountId}
        ORDER BY last_seen_at DESC NULLS LAST, created_at DESC
      `;
  return result as unknown as AssistantChannelContactRecord[];
}

export async function upsertAssistantChannelContact(params: {
  channelAccountId: string;
  externalUserId: string;
  externalChatId: string;
  username?: string | null;
  displayName?: string | null;
}): Promise<AssistantChannelContactRecord> {
  const sql = getDb();
  const result = await sql`
    INSERT INTO assistant_channel_contacts (
      assistant_channel_account_id,
      external_user_id,
      external_chat_id,
      username,
      display_name,
      status,
      first_seen_at,
      last_seen_at
    )
    VALUES (
      ${params.channelAccountId},
      ${params.externalUserId},
      ${params.externalChatId},
      ${params.username ?? null},
      ${params.displayName ?? null},
      'pending',
      NOW(),
      NOW()
    )
    ON CONFLICT (assistant_channel_account_id, external_user_id)
    DO UPDATE SET
      external_chat_id = EXCLUDED.external_chat_id,
      username = EXCLUDED.username,
      display_name = EXCLUDED.display_name,
      last_seen_at = NOW(),
      updated_at = NOW()
    RETURNING *
  `;
  return result[0] as AssistantChannelContactRecord;
}

export async function updateAssistantChannelContactStatus(params: {
  contactId: string;
  status: AssistantChannelContactStatus;
}): Promise<AssistantChannelContactRecord | null> {
  const sql = getDb();
  const result = await sql`
    UPDATE assistant_channel_contacts
    SET
      status = ${params.status},
      approved_at = CASE WHEN ${params.status} = 'approved' THEN NOW() ELSE approved_at END,
      updated_at = NOW()
    WHERE id = ${params.contactId}
    RETURNING *
  `;
  return (result[0] as AssistantChannelContactRecord | undefined) ?? null;
}

export async function touchAssistantChannelContactPairingPrompt(
  contactId: string
): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE assistant_channel_contacts
    SET
      last_pairing_prompt_at = NOW(),
      updated_at = NOW()
    WHERE id = ${contactId}
  `;
}
