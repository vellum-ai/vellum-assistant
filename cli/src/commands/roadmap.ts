import { readPlatformToken, getWebUrl } from "../lib/platform-client.js";
import { loopbackSafeFetch } from "../lib/loopback-fetch.js";

function printUsage(): void {
  console.log("Usage: vellum roadmap <subcommand>");
  console.log("");
  console.log("Manage roadmap items.");
  console.log("");
  console.log("Subcommands:");
  console.log(
    "  list     [--query <q>] [--status <s>] [--tag <slug>] [--sort upvotes|created] [--limit <n>]",
  );
  console.log("  get      <slug>");
  console.log(
    "  create   --title <title> [--description <desc>] [--tag <slug>...]",
  );
  console.log(
    "  update   <slug> [--title <title>] [--description <desc>] [--status <s>] [--tag <slug>...]",
  );
  console.log("  delete   <slug>");
  console.log("  upvote   <slug>");
  console.log("  unvote   <slug>");
  console.log("");
  console.log("Examples:");
  console.log('  $ vellum roadmap list --query "dark mode"');
  console.log("  $ vellum roadmap list --status planned --sort upvotes");
  console.log("  $ vellum roadmap get my-feature-slug");
  console.log('  $ vellum roadmap create --title "Add dark mode"');
  console.log(
    "  $ vellum roadmap update my-feature --status planned --tag integrations",
  );
  console.log("  $ vellum roadmap upvote my-feature-slug");
}

function consumeValue(args: string[], i: number, flag: string): string {
  const next = args[i + 1];
  if (next === undefined || next.startsWith("--")) {
    console.error(`Error: ${flag} requires a value.`);
    process.exit(1);
  }
  return next;
}

function requireAuth(): string {
  const token = readPlatformToken();
  if (!token) {
    console.error("Not logged in. Run `vellum login` first.");
    process.exit(1);
  }
  return token;
}

function requireSlug(args: string[], command: string): string {
  const slug = args[0];
  if (!slug || slug.startsWith("--")) {
    console.error(`Usage: vellum roadmap ${command} <slug>`);
    process.exit(1);
  }
  return slug;
}

const ANSI_RE =
  /[\x00-\x08\x0b-\x1f\x7f]|\x1b(?:\[[0-9;]*[A-Za-z]|\].*?(?:\x07|\x1b\\))/g;
function sanitize(text: string): string {
  return text.replace(ANSI_RE, "");
}

function makeLink(url: string): string {
  return `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;
}

async function apiFetch(
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: Record<string, unknown>;
    params?: Record<string, string>;
  } = {},
): Promise<Response> {
  const webUrl = getWebUrl();
  let url = `${webUrl}/api/marketing${path}`;
  if (options.params) {
    const qs = new URLSearchParams(options.params).toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {};
  if (options.token) headers["X-Session-Token"] = options.token;
  if (options.body) headers["Content-Type"] = "application/json";

  return loopbackSafeFetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

async function handleError(response: Response, action: string): Promise<never> {
  const text = await response.text().catch(() => "");
  console.error(`Failed to ${action} (${response.status}): ${text}`);
  process.exit(1);
}

// ── list ──

interface ListItem {
  slug: string;
  title: string;
  status: string;
  upvote_count: number;
  comment_count: number;
  tags: { slug: string; name: string }[];
  viewer_upvoted: boolean | null;
}

async function roadmapList(args: string[]): Promise<void> {
  const params: Record<string, string> = {};
  const token = readPlatformToken() ?? undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--query":
      case "-q":
        params.q = consumeValue(args, i, "--query");
        i++;
        break;
      case "--status":
        params.status = consumeValue(args, i, "--status");
        i++;
        break;
      case "--tag":
        params.tag = consumeValue(args, i, "--tag");
        i++;
        break;
      case "--sort":
        params.sort = consumeValue(args, i, "--sort");
        i++;
        break;
      case "--limit":
        params.limit = consumeValue(args, i, "--limit");
        i++;
        break;
      case "--offset":
        params.offset = consumeValue(args, i, "--offset");
        i++;
        break;
    }
  }

  const response = await apiFetch("/v1/roadmap", { params, token });
  if (!response.ok) return handleError(response, "list roadmap items");

  const data = (await response.json()) as {
    items: ListItem[];
    total: number;
  };

  if (data.items.length === 0) {
    console.log("No roadmap items found.");
    return;
  }

  const webUrl = getWebUrl();
  console.log(`Showing ${data.items.length} of ${data.total} items:\n`);

  for (const item of data.items) {
    const upvoted = item.viewer_upvoted ? " (upvoted)" : "";
    const tags =
      item.tags.length > 0
        ? ` [${item.tags.map((t) => sanitize(t.slug)).join(", ")}]`
        : "";
    console.log(
      `  ${sanitize(item.title)}  ▲${item.upvote_count}${upvoted}  💬${item.comment_count}  ${item.status}${tags}`,
    );
    console.log(`    ${makeLink(`${webUrl}/roadmap/${item.slug}`)}`);
  }
}

// ── get ──

async function roadmapGet(args: string[]): Promise<void> {
  const slug = requireSlug(args, "get");
  const token = readPlatformToken() ?? undefined;
  const response = await apiFetch(`/v1/roadmap/${slug}`, { token });
  if (!response.ok) return handleError(response, "get roadmap item");

  const item = (await response.json()) as {
    slug: string;
    title: string;
    description: string;
    status: string;
    upvote_count: number;
    comment_count: number;
    tags: { slug: string; name: string }[];
    viewer_upvoted: boolean | null;
    creator_username: string;
    created: string;
    comments: {
      id: string;
      author_username: string;
      author_is_staff: boolean;
      body: string;
      created: string;
    }[];
  };

  const webUrl = getWebUrl();
  const upvoted = item.viewer_upvoted ? " (upvoted)" : "";
  const tags =
    item.tags.length > 0
      ? item.tags.map((t) => sanitize(t.slug)).join(", ")
      : "none";

  console.log(sanitize(item.title));
  console.log(`  slug:     ${item.slug}`);
  console.log(`  status:   ${item.status}`);
  console.log(`  upvotes:  ${item.upvote_count}${upvoted}`);
  console.log(`  tags:     ${tags}`);
  console.log(`  by:       ${sanitize(item.creator_username)}`);
  console.log(`  created:  ${item.created}`);
  console.log(`  url:      ${makeLink(`${webUrl}/roadmap/${item.slug}`)}`);
  if (item.description) {
    console.log(`\n${sanitize(item.description)}`);
  }

  if (item.comments.length > 0) {
    console.log(`\nComments (${item.comments.length}):`);
    for (const c of item.comments) {
      const staff = c.author_is_staff ? " [staff]" : "";
      console.log(`  ${sanitize(c.author_username)}${staff} (${c.created}):`);
      console.log(`    ${sanitize(c.body)}`);
    }
  }
}

// ── create ──

async function roadmapCreate(args: string[]): Promise<void> {
  let title: string | undefined;
  let description: string | undefined;
  const tags: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--title":
        title = consumeValue(args, i, "--title");
        i++;
        break;
      case "--description":
        description = consumeValue(args, i, "--description");
        i++;
        break;
      case "--tag":
        tags.push(consumeValue(args, i, "--tag"));
        i++;
        break;
    }
  }

  if (!title) {
    console.error("Error: --title is required.");
    console.error('Usage: vellum roadmap create --title "My feature request"');
    process.exitCode = 1;
    return;
  }

  const token = requireAuth();
  const body: Record<string, unknown> = { title };
  if (description) body.description = description;
  if (tags.length > 0) body.tags = tags;

  const response = await apiFetch("/v1/roadmap", {
    method: "POST",
    token,
    body,
  });
  if (!response.ok) return handleError(response, "create roadmap item");

  const item = (await response.json()) as {
    slug: string;
    title: string;
    status: string;
  };

  const webUrl = getWebUrl();
  console.log(`Created roadmap item: ${sanitize(item.title)}`);
  console.log(`  slug:   ${item.slug}`);
  console.log(`  status: ${item.status}`);
  console.log(`  url:    ${makeLink(`${webUrl}/roadmap/${item.slug}`)}`);
}

// ── update ──

async function roadmapUpdate(args: string[]): Promise<void> {
  const slug = requireSlug(args, "update");

  let title: string | undefined;
  let description: string | undefined;
  let status: string | undefined;
  const tags: string[] = [];

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--title":
        title = consumeValue(args, i, "--title");
        i++;
        break;
      case "--description":
        description = consumeValue(args, i, "--description");
        i++;
        break;
      case "--status":
        status = consumeValue(args, i, "--status");
        i++;
        break;
      case "--tag":
        tags.push(consumeValue(args, i, "--tag"));
        i++;
        break;
    }
  }

  const body: Record<string, unknown> = {};
  if (title !== undefined) body.title = title;
  if (description !== undefined) body.description = description;
  if (status !== undefined) body.status = status;
  if (tags.length > 0) body.tags = tags;

  if (Object.keys(body).length === 0) {
    console.error("Error: at least one field to update is required.");
    process.exitCode = 1;
    return;
  }

  const token = requireAuth();
  const response = await apiFetch(`/v1/roadmap/${slug}`, {
    method: "PATCH",
    token,
    body,
  });
  if (!response.ok) return handleError(response, "update roadmap item");

  const item = (await response.json()) as {
    slug: string;
    title: string;
    status: string;
  };

  const webUrl = getWebUrl();
  console.log(`Updated roadmap item: ${sanitize(item.title)}`);
  console.log(`  slug:   ${item.slug}`);
  console.log(`  status: ${item.status}`);
  console.log(`  url:    ${makeLink(`${webUrl}/roadmap/${item.slug}`)}`);
}

// ── delete ──

async function roadmapDelete(args: string[]): Promise<void> {
  const slug = requireSlug(args, "delete");
  const token = requireAuth();
  const response = await apiFetch(`/v1/roadmap/${slug}`, {
    method: "DELETE",
    token,
  });
  if (!response.ok) return handleError(response, "delete roadmap item");

  console.log(`Deleted roadmap item: ${slug}`);
}

// ── upvote / unvote ──

async function roadmapUpvote(args: string[]): Promise<void> {
  const slug = requireSlug(args, "upvote");
  const token = requireAuth();
  const response = await apiFetch(`/v1/roadmap/${slug}/upvote`, {
    method: "POST",
    token,
  });
  if (!response.ok) return handleError(response, "upvote roadmap item");

  const data = (await response.json()) as {
    slug: string;
    upvote_count: number;
  };

  console.log(`Upvoted: ${data.slug} (${data.upvote_count} total)`);
}

async function roadmapUnvote(args: string[]): Promise<void> {
  const slug = requireSlug(args, "unvote");
  const token = requireAuth();
  const response = await apiFetch(`/v1/roadmap/${slug}/upvote`, {
    method: "DELETE",
    token,
  });
  if (!response.ok) return handleError(response, "remove upvote");

  const data = (await response.json()) as {
    slug: string;
    upvote_count: number;
  };

  console.log(`Removed upvote: ${data.slug} (${data.upvote_count} total)`);
}

// ── main ──

export async function roadmap(): Promise<void> {
  const args = process.argv.slice(3);
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printUsage();
    return;
  }

  switch (sub) {
    case "list":
    case "ls":
      await roadmapList(args.slice(1));
      break;
    case "get":
    case "show":
      await roadmapGet(args.slice(1));
      break;
    case "create":
      await roadmapCreate(args.slice(1));
      break;
    case "update":
      await roadmapUpdate(args.slice(1));
      break;
    case "delete":
    case "rm":
      await roadmapDelete(args.slice(1));
      break;
    case "upvote":
      await roadmapUpvote(args.slice(1));
      break;
    case "unvote":
      await roadmapUnvote(args.slice(1));
      break;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      printUsage();
      process.exitCode = 1;
  }
}
