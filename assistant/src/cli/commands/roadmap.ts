/**
 * `assistant roadmap` — read and file public Vellum roadmap feedback as the
 * assistant itself.
 *
 * Mirrors the user-facing `vellum roadmap` CLI (cli/src/commands/roadmap.ts)
 * but authenticates with the assistant's own platform API key instead of a
 * user session token. The key is revealed from the daemon's credential vault
 * over IPC (service `vellum`, field `assistant_api_key`) and is used only in
 * the Authorization header — it is never logged, echoed, or included in
 * error output, and never written to disk.
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";
import { roadmapHelp } from "./roadmap.help.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_MARKETING_URL = "https://marketing.vellum.ai";
const DEFAULT_WEB_URL = "https://www.vellum.ai";

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function marketingBaseUrl(): string {
  return stripTrailingSlashes(
    process.env.VELLUM_MARKETING_URL ?? DEFAULT_MARKETING_URL,
  );
}

function webBaseUrl(): string {
  return stripTrailingSlashes(process.env.VELLUM_WEB_URL ?? DEFAULT_WEB_URL);
}

// ---------------------------------------------------------------------------
// Assistant auth
// ---------------------------------------------------------------------------

/**
 * Reveal the assistant's own platform API key from the credential vault.
 * Resolves undefined when the assistant is not connected to the platform, so
 * read subcommands can fall back to anonymous. The plaintext value stays in
 * local scope and is never rendered or logged.
 */
async function getAssistantApiKey(): Promise<string | undefined> {
  const r = await cliIpcCall<{ value: string }>("credentials_reveal", {
    body: { service: "vellum", field: "assistant_api_key" },
  });
  return r.ok ? r.result?.value : undefined;
}

// ---------------------------------------------------------------------------
// Marketing API client
// ---------------------------------------------------------------------------

/**
 * The marketing service requires exactly `Authorization: Api-Key <key>`.
 * `X-Api-Key` must NOT be used: the service's header lookup is
 * case-insensitive and that name collides with an unrelated internal service
 * credential, so any other header form is treated as anonymous.
 */
async function roadmapFetch(
  path: string,
  opts: {
    method?: string;
    key?: string;
    body?: Record<string, unknown>;
    params?: Record<string, string | undefined>;
  } = {},
): Promise<Response> {
  let url = `${marketingBaseUrl()}/v1/roadmap${path}`;
  const entries = Object.entries(opts.params ?? {}).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const qs = new URLSearchParams(entries).toString();
  if (qs) url += `?${qs}`;

  const headers: Record<string, string> = {};
  if (opts.key) headers.Authorization = `Api-Key ${opts.key}`;
  if (opts.body) headers["Content-Type"] = "application/json";

  return fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// API response shapes
// ---------------------------------------------------------------------------

interface RoadmapTag {
  slug: string;
  name: string;
}

interface RoadmapItemSummary {
  slug: string;
  title: string;
  status: string;
  upvote_count: number;
  comment_count: number;
  tags: RoadmapTag[];
  viewer_upvoted: boolean | null;
}

interface RoadmapComment {
  id: string;
  author_username: string;
  author_kind?: string;
  author_is_staff: boolean;
  body: string;
  created: string;
}

interface RoadmapItemDetail extends RoadmapItemSummary {
  description: string;
  creator_username: string;
  creator_kind?: string;
  created: string;
  comments: RoadmapComment[];
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const ANSI_RE =
  /[\x00-\x08\x0b-\x1f\x7f]|\x1b(?:\[[0-9;]*[A-Za-z]|\].*?(?:\x07|\x1b\\))/g;
function sanitize(text: string): string {
  return text.replace(ANSI_RE, "");
}

function makeLink(url: string): string {
  return `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;
}

function itemUrl(slug: string): string {
  return `${webBaseUrl()}/roadmap/${slug}`;
}

function writeError(cmd: Command, message: string): void {
  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, { ok: false, error: message });
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
  process.exitCode = 1;
}

/** Surface an HTTP failure. The response body never contains the API key. */
async function apiError(
  cmd: Command,
  response: Response,
  action: string,
): Promise<void> {
  const text = (await response.text().catch(() => "")).trim();
  const snippet = text.length > 300 ? `${text.slice(0, 300)}…` : text;
  writeError(
    cmd,
    `Failed to ${action} (${response.status})${snippet ? `: ${snippet}` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

interface ListOpts {
  query?: string;
  status?: string;
  tag?: string;
  sort?: string;
  limit?: string;
  offset?: string;
}

async function runList(cmd: Command, opts: ListOpts): Promise<void> {
  const key = await getAssistantApiKey();
  const response = await roadmapFetch("", {
    key,
    params: {
      q: opts.query,
      status: opts.status,
      tag: opts.tag,
      sort: opts.sort,
      limit: opts.limit,
      offset: opts.offset,
    },
  });
  if (!response.ok) return apiError(cmd, response, "list roadmap items");

  const data = (await response.json()) as {
    items: RoadmapItemSummary[];
    total: number;
  };

  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, { ok: true, ...data });
    return;
  }

  if (data.items.length === 0) {
    log.info("No roadmap items found.");
    return;
  }

  log.info(`Showing ${data.items.length} of ${data.total} items:`);
  log.info("");
  for (const item of data.items) {
    const upvoted = item.viewer_upvoted ? " (upvoted)" : "";
    const tags =
      item.tags.length > 0
        ? ` [${item.tags.map((t) => sanitize(t.slug)).join(", ")}]`
        : "";
    log.info(
      `  ${sanitize(item.title)}  ▲${item.upvote_count}${upvoted}  💬${item.comment_count}  ${item.status}${tags}`,
    );
    log.info(`    ${makeLink(itemUrl(item.slug))}`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: get
// ---------------------------------------------------------------------------

async function runGet(cmd: Command, slug: string): Promise<void> {
  const key = await getAssistantApiKey();
  const response = await roadmapFetch(`/${slug}`, { key });
  if (!response.ok) return apiError(cmd, response, "get roadmap item");

  const item = (await response.json()) as RoadmapItemDetail;

  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, { ok: true, item });
    return;
  }

  const upvoted = item.viewer_upvoted ? " (upvoted)" : "";
  const tags =
    item.tags.length > 0
      ? item.tags.map((t) => sanitize(t.slug)).join(", ")
      : "none";
  const creator =
    item.creator_kind === "assistant"
      ? `${sanitize(item.creator_username)} (assistant)`
      : sanitize(item.creator_username);

  log.info(sanitize(item.title));
  log.info(`  slug:     ${item.slug}`);
  log.info(`  status:   ${item.status}`);
  log.info(`  upvotes:  ${item.upvote_count}${upvoted}`);
  log.info(`  tags:     ${tags}`);
  log.info(`  by:       ${creator}`);
  log.info(`  created:  ${item.created}`);
  log.info(`  url:      ${makeLink(itemUrl(item.slug))}`);
  if (item.description) {
    log.info("");
    log.info(sanitize(item.description));
  }

  if (item.comments.length > 0) {
    log.info("");
    log.info(`Comments (${item.comments.length}):`);
    for (const c of item.comments) {
      const marker =
        c.author_kind === "assistant"
          ? " [assistant]"
          : c.author_is_staff
            ? " [staff]"
            : "";
      log.info(`  ${sanitize(c.author_username)}${marker} (${c.created}):`);
      log.info(`    ${sanitize(c.body)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Subcommand: create
// ---------------------------------------------------------------------------

interface CreateOpts {
  title: string;
  description?: string;
  tag?: string[];
}

async function runCreate(cmd: Command, opts: CreateOpts): Promise<void> {
  const key = await requireKey(cmd);
  if (!key) return;

  const body: Record<string, unknown> = { title: opts.title };
  if (opts.description) body.description = opts.description;
  if (opts.tag && opts.tag.length > 0) body.tags = opts.tag;

  const response = await roadmapFetch("", { method: "POST", key, body });
  if (!response.ok) return apiError(cmd, response, "create roadmap item");

  const item = (await response.json()) as RoadmapItemSummary & {
    creator_kind?: string;
    creator_username?: string;
  };

  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, { ok: true, item });
    return;
  }

  log.info(`Created roadmap item: ${sanitize(item.title)}`);
  log.info(`  slug:   ${item.slug}`);
  log.info(`  status: ${item.status}`);
  log.info(`  url:    ${makeLink(itemUrl(item.slug))}`);
}

// ---------------------------------------------------------------------------
// Subcommand: update
// ---------------------------------------------------------------------------

interface UpdateOpts {
  title?: string;
  description?: string;
  status?: string;
  tag?: string[];
}

async function runUpdate(
  cmd: Command,
  slug: string,
  opts: UpdateOpts,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.title !== undefined) body.title = opts.title;
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.status !== undefined) body.status = opts.status;
  if (opts.tag && opts.tag.length > 0) body.tags = opts.tag;

  if (Object.keys(body).length === 0) {
    writeError(cmd, "At least one field to update is required.");
    return;
  }

  const key = await requireKey(cmd);
  if (!key) return;

  const response = await roadmapFetch(`/${slug}`, {
    method: "PATCH",
    key,
    body,
  });
  if (!response.ok) return apiError(cmd, response, "update roadmap item");

  const item = (await response.json()) as RoadmapItemSummary;

  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, { ok: true, item });
    return;
  }

  log.info(`Updated roadmap item: ${sanitize(item.title)}`);
  log.info(`  slug:   ${item.slug}`);
  log.info(`  status: ${item.status}`);
  log.info(`  url:    ${makeLink(itemUrl(item.slug))}`);
}

// ---------------------------------------------------------------------------
// Subcommand: delete
// ---------------------------------------------------------------------------

async function runDelete(cmd: Command, slug: string): Promise<void> {
  const key = await requireKey(cmd);
  if (!key) return;

  const response = await roadmapFetch(`/${slug}`, { method: "DELETE", key });
  if (!response.ok) return apiError(cmd, response, "delete roadmap item");

  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, { ok: true, slug });
    return;
  }

  log.info(`Deleted roadmap item: ${slug}`);
}

// ---------------------------------------------------------------------------
// Subcommands: upvote / unvote
// ---------------------------------------------------------------------------

async function runVote(
  cmd: Command,
  slug: string,
  method: "POST" | "DELETE",
  action: string,
): Promise<void> {
  const key = await requireKey(cmd);
  if (!key) return;

  const response = await roadmapFetch(`/${slug}/upvote`, { method, key });
  if (!response.ok) return apiError(cmd, response, action);

  const data = (await response.json()) as {
    slug: string;
    upvote_count: number;
  };

  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, { ok: true, ...data });
    return;
  }

  log.info(
    method === "POST"
      ? `Upvoted: ${data.slug} (${data.upvote_count} total)`
      : `Removed upvote: ${data.slug} (${data.upvote_count} total)`,
  );
}

// ---------------------------------------------------------------------------
// Shared auth gate for write subcommands
// ---------------------------------------------------------------------------

async function requireKey(cmd: Command): Promise<string | undefined> {
  const key = await getAssistantApiKey();
  if (!key) {
    writeError(
      cmd,
      "Not connected to the Vellum Platform (no assistant API key stored). " +
        "Run `assistant platform connect` first.",
    );
    return undefined;
  }
  return key;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Commander collector for the repeatable `--tag` option. */
function collectTag(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerRoadmapCommand(program: Command): void {
  registerCommand(program, {
    name: roadmapHelp.name,
    transport: "ipc",
    description: roadmapHelp.description,
    build: (roadmap) => {
      applyCommandHelp(roadmap, roadmapHelp);

      subcommand(roadmap, "list").action(async (opts: ListOpts, cmd: Command) =>
        runList(cmd, opts),
      );

      subcommand(roadmap, "get").action(
        async (slug: string, _opts: Record<string, unknown>, cmd: Command) =>
          runGet(cmd, slug),
      );

      // `--tag` uses an array-accumulating collector, which the declarative
      // help contract cannot express — it is registered imperatively here
      // (with the trailing `--json` after it, preserving option order).
      subcommand(roadmap, "create")
        .option(
          "--tag <slug>",
          "Tag slug (repeatable)",
          collectTag,
          [] as string[],
        )
        .option("--json", "Output as JSON")
        .action(async (opts: CreateOpts, cmd: Command) => runCreate(cmd, opts));

      subcommand(roadmap, "update")
        .option(
          "--tag <slug>",
          "Tag slug (repeatable)",
          collectTag,
          [] as string[],
        )
        .option("--json", "Output as JSON")
        .action(async (slug: string, opts: UpdateOpts, cmd: Command) =>
          runUpdate(cmd, slug, opts),
        );

      subcommand(roadmap, "delete").action(
        async (slug: string, _opts: Record<string, unknown>, cmd: Command) =>
          runDelete(cmd, slug),
      );

      subcommand(roadmap, "upvote").action(
        async (slug: string, _opts: Record<string, unknown>, cmd: Command) =>
          runVote(cmd, slug, "POST", "upvote roadmap item"),
      );

      subcommand(roadmap, "unvote").action(
        async (slug: string, _opts: Record<string, unknown>, cmd: Command) =>
          runVote(cmd, slug, "DELETE", "remove upvote"),
      );
    },
  });
}
