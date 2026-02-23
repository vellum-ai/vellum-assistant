/**
 * Vellum email provider — calls the Vellum platform email API.
 *
 * Only supports the two operations needed by the bundled email skill:
 *   - status()              — list existing inboxes / check connectivity
 *   - createInbox(username) — provision a new inbox
 */

// ---------------------------------------------------------------------------
// Types returned by the provider
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
// Provider
// ---------------------------------------------------------------------------

export class VellumProvider {
  readonly name = "vellum";
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? "https://api.vellum.ai";
  }

  /** Return current email status: connectivity + list of inboxes. */
  async status(): Promise<EmailStatus> {
    const result = await vellumFetch(
      this.apiKey,
      this.baseUrl,
      "/v1/email/inboxes",
    );
    const inboxes = (result as { inboxes: EmailInbox[] }).inboxes;
    return { provider: this.name, ok: true, inboxes };
  }

  /** Provision a new inbox for the given username. */
  async createInbox(username: string): Promise<EmailInbox> {
    const result = await vellumFetch(
      this.apiKey,
      this.baseUrl,
      "/v1/email/inboxes",
      {
        method: "POST",
        body: { username },
      },
    );
    return result as EmailInbox;
  }
}
