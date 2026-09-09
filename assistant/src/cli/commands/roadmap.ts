/**
 * `assistant roadmap`: read and file public Vellum roadmap feedback as the
 * assistant itself.
 *
 * Forwards to the daemon's roadmap routes and renders the result. The
 * assistant's platform API key never reaches this process: the daemon reads it
 * from the credential vault and signs the roadmap call itself.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { stripAnsiAndControlChars as sanitize } from "../../util/ansi.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeError, writeOutput } from "../output.js";
import { roadmapHelp } from "./roadmap.help.js";

// ---------------------------------------------------------------------------
// Response shapes (mirrors of the route's zod schemas)
// ---------------------------------------------------------------------------

interface RoadmapItem {
  slug: string;
  title: string;
  status: string;
  url: string;
  upvoteCount: number;
  commentCount: number;
  tags: { slug: string; name: string }[];
  viewerUpvoted: boolean | null;
}

interface RoadmapComment {
  id: string;
  authorUsername: string;
  authorKind: string | null;
  authorIsStaff: boolean;
  body: string;
  created: string;
}

/** What create and update answer with: the item's identity, no counts. */
type MutatedRoadmapItem = Pick<
  RoadmapItem,
  "slug" | "title" | "status" | "url"
>;

interface RoadmapItemDetail extends RoadmapItem {
  description: string;
  creatorUsername: string;
  creatorKind: string | null;
  created: string;
  comments: RoadmapComment[];
}

interface VoteResult {
  slug: string;
  upvoteCount: number;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** OSC-8 hyperlink, so terminals that support it render a clickable URL. */
function makeLink(url: string): string {
  return `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;
}

/**
 * Print untrusted prose. `sanitize` flattens control characters along with
 * escape sequences, which is what the one-line fields want; going line by line
 * keeps the paragraph's shape while every line still gets stripped.
 */
function logParagraph(text: string, indent = ""): void {
  for (const line of text.split("\n")) {
    log.info(`${indent}${sanitize(line)}`);
  }
}

function tagList(item: RoadmapItem): string {
  return item.tags.map((t) => sanitize(t.slug)).join(", ");
}

/** Print the shared "what changed" block used by create and update. */
function logItemSummary(heading: string, item: MutatedRoadmapItem): void {
  log.info(`${heading}: ${sanitize(item.title)}`);
  log.info(`  slug:   ${item.slug}`);
  log.info(`  status: ${item.status}`);
  log.info(`  url:    ${makeLink(item.url)}`);
}

/**
 * Forward one subcommand to its daemon route and hand back the payload, or
 * exit with the route's own status-derived exit code.
 */
async function call<T>(
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const r = await cliIpcCall<T>(method, params);
  if (!r.ok || r.result === undefined) {
    return exitFromIpcResult(r);
  }
  return r.result;
}

// ---------------------------------------------------------------------------
// Subcommands
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
  const data = await call<{ items: RoadmapItem[]; total: number }>(
    "roadmap_list",
    {
      queryParams: {
        q: opts.query,
        status: opts.status,
        tag: opts.tag,
        sort: opts.sort,
        limit: opts.limit,
        offset: opts.offset,
      },
    },
  );

  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, data);
    return;
  }

  if (data.items.length === 0) {
    log.info("No roadmap items found.");
    return;
  }

  log.info(`Showing ${data.items.length} of ${data.total} items:`);
  log.info("");
  for (const item of data.items) {
    const upvoted = item.viewerUpvoted ? " (upvoted)" : "";
    const tags = item.tags.length > 0 ? ` [${tagList(item)}]` : "";
    log.info(
      `  ${sanitize(item.title)}  ▲${item.upvoteCount}${upvoted}  💬${item.commentCount}  ${item.status}${tags}`,
    );
    log.info(`    ${makeLink(item.url)}`);
  }
}

async function runGet(cmd: Command, slug: string): Promise<void> {
  const item = await call<RoadmapItemDetail>("roadmap_get", {
    pathParams: { slug },
  });

  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, item);
    return;
  }

  const upvoted = item.viewerUpvoted ? " (upvoted)" : "";
  const creator =
    item.creatorKind === "assistant"
      ? `${sanitize(item.creatorUsername)} (assistant)`
      : sanitize(item.creatorUsername);

  log.info(sanitize(item.title));
  log.info(`  slug:     ${item.slug}`);
  log.info(`  status:   ${item.status}`);
  log.info(`  upvotes:  ${item.upvoteCount}${upvoted}`);
  log.info(`  tags:     ${item.tags.length > 0 ? tagList(item) : "none"}`);
  log.info(`  by:       ${creator}`);
  log.info(`  created:  ${item.created}`);
  log.info(`  url:      ${makeLink(item.url)}`);
  if (item.description) {
    log.info("");
    logParagraph(item.description);
  }

  if (item.comments.length > 0) {
    log.info("");
    log.info(`Comments (${item.comments.length}):`);
    for (const c of item.comments) {
      const marker =
        c.authorKind === "assistant"
          ? " [assistant]"
          : c.authorIsStaff
            ? " [staff]"
            : "";
      log.info(`  ${sanitize(c.authorUsername)}${marker} (${c.created}):`);
      logParagraph(c.body, "    ");
    }
  }
}

interface CreateOpts {
  title: string;
  description?: string;
  tag?: string[];
}

async function runCreate(cmd: Command, opts: CreateOpts): Promise<void> {
  const item = await call<MutatedRoadmapItem>("roadmap_create", {
    body: {
      title: opts.title,
      description: opts.description,
      tags: opts.tag,
    },
  });

  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, item);
    return;
  }
  logItemSummary("Created roadmap item", item);
}

interface UpdateOpts {
  title?: string;
  description?: string;
  status?: string;
  tag?: string[];
  clearTags?: boolean;
}

async function runUpdate(
  cmd: Command,
  slug: string,
  opts: UpdateOpts,
): Promise<void> {
  if (opts.clearTags && opts.tag) {
    writeError(
      cmd,
      "--clear-tags and --tag conflict. Drop --clear-tags to set tags, or drop --tag to remove them all.",
    );
    process.exitCode = 1;
    return;
  }

  const item = await call<MutatedRoadmapItem>("roadmap_update", {
    pathParams: { slug },
    body: {
      title: opts.title,
      description: opts.description,
      status: opts.status,
      // `--tag` always carries a value, so an empty set is only reachable
      // through `--clear-tags`.
      tags: opts.clearTags ? [] : opts.tag,
    },
  });

  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, item);
    return;
  }
  logItemSummary("Updated roadmap item", item);
}

async function runDelete(cmd: Command, slug: string): Promise<void> {
  const result = await call<{ slug: string; deleted: true }>("roadmap_delete", {
    pathParams: { slug },
  });

  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, result);
    return;
  }
  log.info(`Deleted roadmap item: ${result.slug}`);
}

async function runVote(
  cmd: Command,
  slug: string,
  method: "roadmap_upvote" | "roadmap_unvote",
): Promise<void> {
  const result = await call<VoteResult>(method, { pathParams: { slug } });

  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, result);
    return;
  }
  const verb = method === "roadmap_upvote" ? "Upvoted" : "Removed upvote";
  log.info(`${verb}: ${result.slug} (${result.upvoteCount} total)`);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Let `--tag` repeat. The declarative help contract carries plain data only,
 * so the accumulator is attached to the declared option here, before Commander
 * parses anything.
 */
function makeTagRepeatable(command: Command): void {
  const option = command.options.find((o) => o.flags === "--tag <slug>");
  if (!option) {
    throw new Error(
      `Option "--tag <slug>" not found on "roadmap ${command.name()}". Is it declared in roadmap.help.ts?`,
    );
  }
  option.argParser((value: string, prev: string[] | undefined) => [
    ...(prev ?? []),
    value,
  ]);
}

export function registerRoadmapCommand(program: Command): void {
  registerCommand(program, {
    name: roadmapHelp.name,
    transport: "ipc",
    description: roadmapHelp.description,
    build: (roadmap) => {
      applyCommandHelp(roadmap, roadmapHelp);

      subcommand(roadmap, "list").action((opts: ListOpts, cmd: Command) =>
        runList(cmd, opts),
      );

      subcommand(roadmap, "get").action(
        (slug: string, _opts: unknown, cmd: Command) => runGet(cmd, slug),
      );

      const create = subcommand(roadmap, "create");
      makeTagRepeatable(create);
      create.action((opts: CreateOpts, cmd: Command) => runCreate(cmd, opts));

      const update = subcommand(roadmap, "update");
      makeTagRepeatable(update);
      update.action((slug: string, opts: UpdateOpts, cmd: Command) =>
        runUpdate(cmd, slug, opts),
      );

      subcommand(roadmap, "delete").action(
        (slug: string, _opts: unknown, cmd: Command) => runDelete(cmd, slug),
      );

      subcommand(roadmap, "upvote").action(
        (slug: string, _opts: unknown, cmd: Command) =>
          runVote(cmd, slug, "roadmap_upvote"),
      );

      subcommand(roadmap, "unvote").action(
        (slug: string, _opts: unknown, cmd: Command) =>
          runVote(cmd, slug, "roadmap_unvote"),
      );
    },
  });
}
