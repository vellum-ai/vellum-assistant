/**
 * Vellum email API client — calls the Vellum platform email endpoints.
 */

// The domain for the Vellum email API is still being finalized and may change.
const DEFAULT_VELLUM_API_URL = "https://api.vellum.ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailInbox {
  id: string;
  address: string;
  displayName?: string;
  createdAt: string;
}

export interface EmailStatus {
  provider: string;
  ok: boolean;
  inboxes: EmailInbox[];
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function vellumFetch(
  apiKey: string,
  baseUrl: string,
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Vellum email API error: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class VellumEmailClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl?: string) {
    const resolvedKey = apiKey ?? process.env.VELLUM_API_KEY;
    if (!resolvedKey) {
      throw new Error(
        "No Vellum API key configured. Set the VELLUM_API_KEY environment variable.",
      );
    }
    this.apiKey = resolvedKey;
    this.baseUrl =
      baseUrl ?? process.env.VELLUM_API_URL ?? DEFAULT_VELLUM_API_URL;
  }

  /** List existing email addresses and check connectivity. */
  async status(): Promise<EmailStatus> {
    const result = await vellumFetch(
      this.apiKey,
      this.baseUrl,
      "/v1/email-addresses",
    );
    const inboxes = (result as { inboxes: EmailInbox[] }).inboxes;
    return { provider: "vellum", ok: true, inboxes };
  }

  /** Provision a new email address for the given username. */
  async createInbox(username: string): Promise<EmailInbox> {
    const result = await vellumFetch(
      this.apiKey,
      this.baseUrl,
      "/v1/email-addresses",
      {
        method: "POST",
        body: { username },
      },
    );
    return result as EmailInbox;
  }
}
