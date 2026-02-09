const AGENTMAIL_API_BASE = "https://api.agentmail.to/v0";

interface AgentMailInbox {
  pod_id: string;
  inbox_id: string;
  updated_at: string;
  created_at: string;
  display_name: string | null;
  client_id: string | null;
}

interface AgentMailWebhook {
  webhook_id: string;
  url: string;
  secret: string;
  enabled: boolean;
  event_types: string[] | null;
  inbox_ids: string[] | null;
}

function assistantNameToUsername(assistantName: string): string {
  return agentName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 64);
}

function getAgentMailApiKey(): string {
  const apiKey = process.env.AGENT_MAIL_API_KEY;
  if (!apiKey) {
    throw new Error("AGENT_MAIL_API_KEY environment variable is not set");
  }
  return apiKey;
}

export async function createAssistantMailInbox(
  assistantName: string,
  assistantId: string
): Promise<AgentMailInbox> {
  const apiKey = getAgentMailApiKey();
  const username = assistantNameToUsername(assistantName);

  const response = await fetch(`${AGENTMAIL_API_BASE}/inboxes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username,
      display_name: assistantName,
      client_id: assistantId,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `AgentMail inbox creation failed (${response.status}): ${errorBody}`
    );
  }

  return response.json() as Promise<AgentMailInbox>;
}

export async function deleteAssistantMailInbox(inboxId: string): Promise<void> {
  const apiKey = getAgentMailApiKey();

  const response = await fetch(`${AGENTMAIL_API_BASE}/inboxes/${encodeURIComponent(inboxId)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok && response.status !== 404) {
    const errorBody = await response.text();
    throw new Error(
      `AgentMail inbox deletion failed (${response.status}): ${errorBody}`
    );
  }
}

export async function deleteAssistantMailWebhook(webhookId: string): Promise<void> {
  const apiKey = getAgentMailApiKey();

  const response = await fetch(`${AGENTMAIL_API_BASE}/webhooks/${encodeURIComponent(webhookId)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok && response.status !== 404) {
    const errorBody = await response.text();
    throw new Error(
      `AgentMail webhook deletion failed (${response.status}): ${errorBody}`
    );
  }
}

export async function registerAssistantMailWebhook(
  inboxId: string
): Promise<AgentMailWebhook> {
  const apiKey = getAgentMailApiKey();

  const appUrl = process.env.APP_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!appUrl) {
    throw new Error(
      "APP_URL or VERCEL_PROJECT_PRODUCTION_URL environment variable is not set"
    );
  }

  const baseUrl = appUrl.startsWith("http") ? appUrl : `https://${appUrl}`;
  const webhookUrl = `${baseUrl}/api/webhooks/agentmail`;

  const response = await fetch(`${AGENTMAIL_API_BASE}/webhooks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: webhookUrl,
      event_types: ["message.received"],
      inbox_ids: [inboxId],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `AgentMail webhook creation failed (${response.status}): ${errorBody}`
    );
  }

  return response.json() as Promise<AgentMailWebhook>;
}
