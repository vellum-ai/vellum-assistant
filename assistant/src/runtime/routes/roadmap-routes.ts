/**
 * Public Vellum roadmap, acted on as the assistant itself.
 *
 * Mirrors the surface of the user-facing `vellum roadmap` CLI
 * (`cli/src/commands/roadmap.ts`), but authenticates with the assistant's own
 * platform API key instead of the owner's session token, so items, upvotes and
 * comments are attributed to the assistant (`creator_kind: assistant`).
 *
 * The key never leaves the daemon: it is read from the credential vault here
 * and used only in the `Authorization` header. Reads fall back to anonymous
 * when nothing is stored; writes fail with a connect-first message.
 *
 *   GET    /v1/roadmap              : list items
 *   GET    /v1/roadmap/:slug        : one item with its comments
 *   POST   /v1/roadmap              : file an item
 *   PATCH  /v1/roadmap/:slug        : edit an item
 *   DELETE /v1/roadmap/:slug        : remove an item
 *   POST   /v1/roadmap/:slug/upvote : upvote (idempotent)
 *   DELETE /v1/roadmap/:slug/upvote : remove the upvote
 */

import { SEEDS } from "@vellumai/environments";
import { z } from "zod";

import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  BadGatewayError,
  BadRequestError,
  ForbiddenError,
  GatewayTimeoutError,
  NotFoundError,
  UnprocessableEntityError,
} from "./errors.js";
import type {
  RouteDefinition,
  RouteHandlerArgs,
  RoutePathParam,
} from "./types.js";

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const DEFAULT_MARKETING_URL = "https://marketing.vellum.ai";

/**
 * Deadline for one roadmap call, set below the CLI's 60s IPC timeout on
 * purpose. Closing the IPC socket does not abort a handler, so without this a
 * slow `create` would keep going and publish a public item after its caller
 * had already been told the request failed, and the retry would file a second
 * one.
 */
const ROADMAP_REQUEST_TIMEOUT_MS = 30_000;

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Marketing service that serves the roadmap API. Reached directly rather than
 * through the `www.vellum.ai/api/marketing` proxy the user-facing CLI uses:
 * that proxy carries the owner's session cookie, which is exactly the identity
 * this surface exists to avoid.
 *
 * Only production has a default, and deliberately so. The roadmap is a single
 * public site, so an unconfigured staging or dev assistant that fell back to
 * it would file real items under its own name and hand a non-production key to
 * a production host. Outside production the endpoint has to be named.
 */
function marketingBaseUrl(): string {
  const override = process.env.VELLUM_MARKETING_URL?.trim();
  if (override) {
    return stripTrailingSlashes(override);
  }
  const env = process.env.VELLUM_ENVIRONMENT?.trim();
  if (env && env !== "production") {
    throw new UnprocessableEntityError(
      `The Vellum roadmap has no ${env} deployment. Set VELLUM_MARKETING_URL to the roadmap service for this environment, or run the assistant in production.`,
    );
  }
  return DEFAULT_MARKETING_URL;
}

/** Site that renders roadmap items, for the human-facing item links. */
function webBaseUrl(): string {
  const override = process.env.VELLUM_WEB_URL?.trim();
  if (override) {
    return stripTrailingSlashes(override);
  }
  const env = process.env.VELLUM_ENVIRONMENT?.trim();
  const seed = (env ? SEEDS[env] : undefined) ?? SEEDS.production;
  return stripTrailingSlashes(seed.webUrl);
}

function itemUrl(slug: string): string {
  return `${webBaseUrl()}/roadmap/${slug}`;
}

// ---------------------------------------------------------------------------
// Assistant auth
// ---------------------------------------------------------------------------

/**
 * The assistant's own platform API key, or undefined when the assistant is not
 * connected to the platform.
 */
async function assistantApiKey(): Promise<string | undefined> {
  const key = await getSecureKeyAsync(
    credentialKey("vellum", "assistant_api_key"),
  );
  return key?.trim() || undefined;
}

/** Same, but for writes, which have no anonymous fallback. */
async function requireAssistantApiKey(): Promise<string> {
  const key = await assistantApiKey();
  if (!key) {
    throw new UnprocessableEntityError(
      "Not connected to the Vellum Platform, so there is no assistant identity to post as. " +
        "Run `assistant platform connect` first.",
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Marketing API client
// ---------------------------------------------------------------------------

/**
 * The marketing service accepts the assistant key only as
 * `Authorization: Api-Key <key>`. `X-Api-Key` must NOT be used: that name
 * collides with an unrelated internal service credential under the service's
 * case-insensitive header lookup, and a request carrying it is served as
 * anonymous.
 */
async function roadmapFetch(
  path: string,
  opts: {
    method?: string;
    key?: string;
    body?: Record<string, unknown>;
    params?: Record<string, string | undefined>;
    signal?: AbortSignal;
  } = {},
): Promise<Response> {
  const query = new URLSearchParams(
    Object.entries(opts.params ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ).toString();
  const url = `${marketingBaseUrl()}/v1/roadmap${path}${query ? `?${query}` : ""}`;

  const headers: Record<string, string> = {};
  if (opts.key) {
    headers.Authorization = `Api-Key ${opts.key}`;
  }
  if (opts.body) {
    headers["Content-Type"] = "application/json";
  }

  const deadline = AbortSignal.timeout(ROADMAP_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline,
    });
  } catch (err) {
    if (deadline.aborted) {
      throw new GatewayTimeoutError(
        `The Vellum roadmap service did not answer within ${ROADMAP_REQUEST_TIMEOUT_MS / 1000}s.`,
      );
    }
    throw new BadGatewayError(
      `Could not reach the Vellum roadmap service: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Translate a non-2xx roadmap response into the matching route error, so the
 * upstream verdict (missing item, rejected key, malformed field) survives to
 * the caller instead of collapsing into one status. The body is safe to quote:
 * the key travels in a header and is never echoed back.
 */
async function throwRoadmapError(
  response: Response,
  action: string,
): Promise<never> {
  const text = (await response.text().catch(() => "")).trim();
  const detail = text.length > 300 ? `${text.slice(0, 300)}…` : text;
  const message = `Failed to ${action} (${response.status})${detail ? `: ${detail}` : ""}`;

  if (response.status === 404) {
    throw new NotFoundError(message);
  }
  if (response.status === 401 || response.status === 403) {
    throw new ForbiddenError(message);
  }
  if (response.status === 422) {
    throw new UnprocessableEntityError(message);
  }
  if (response.status < 500) {
    throw new BadRequestError(message);
  }
  throw new BadGatewayError(message);
}

async function roadmapJson<T>(response: Response, action: string): Promise<T> {
  if (!response.ok) {
    await throwRoadmapError(response, action);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new BadGatewayError(
      `The roadmap service returned a malformed response to ${action}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Upstream payloads
// ---------------------------------------------------------------------------

interface UpstreamTag {
  slug: string;
  name: string;
}

/** All a mutation answers with. A listing carries the rest. */
interface UpstreamMutatedItem {
  slug: string;
  title: string;
  status: string;
}

interface UpstreamItem extends UpstreamMutatedItem {
  upvote_count: number;
  comment_count: number;
  tags?: UpstreamTag[];
  viewer_upvoted?: boolean | null;
}

interface UpstreamComment {
  id: string;
  author_username: string;
  author_kind?: string | null;
  author_is_staff?: boolean;
  body: string;
  created: string;
}

interface UpstreamItemDetail extends UpstreamItem {
  description?: string;
  creator_username: string;
  creator_kind?: string | null;
  created: string;
  comments?: UpstreamComment[];
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

const tagSchema = z.object({ slug: z.string(), name: z.string() });

const itemSchema = z.object({
  slug: z.string(),
  title: z.string(),
  status: z.string(),
  url: z.string().describe("Public page for this item"),
  upvoteCount: z.number(),
  commentCount: z.number(),
  tags: z.array(tagSchema),
  viewerUpvoted: z
    .boolean()
    .nullable()
    .describe("Whether the assistant has upvoted; null when read anonymously"),
});

const commentSchema = z.object({
  id: z.string(),
  authorUsername: z.string(),
  authorKind: z.string().nullable().describe("e.g. 'assistant' or 'user'"),
  authorIsStaff: z.boolean(),
  body: z.string(),
  created: z.string(),
});

const itemDetailSchema = itemSchema.extend({
  description: z.string(),
  creatorUsername: z.string(),
  creatorKind: z.string().nullable(),
  created: z.string(),
  comments: z.array(commentSchema),
});

/**
 * What a create or update answers with. Deliberately narrower than
 * {@link itemSchema}: the marketing API returns only the item's identity on a
 * mutation, so advertising counts here would promise fields that arrive
 * undefined.
 */
const mutatedItemSchema = itemSchema.pick({
  slug: true,
  title: true,
  status: true,
  url: true,
});

const voteSchema = z.object({ slug: z.string(), upvoteCount: z.number() });

// The declared request schemas double as the runtime validators, so the
// OpenAPI contract and what the handler actually accepts cannot drift.
const createRequestSchema = z.object({
  title: z
    .string()
    .refine((v) => v.trim().length > 0, "title is required")
    .describe("Item title"),
  description: z.string().optional(),
  tags: z.array(z.string()).optional().describe("Tag slugs"),
});

const updateRequestSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    status: z.string().optional(),
    tags: z.array(z.string()).optional().describe("Tag slugs"),
  })
  .refine(
    (patch) => Object.values(patch).some((v) => v !== undefined),
    "At least one of title, description, status or tags is required.",
  );

type RoadmapItem = z.infer<typeof itemSchema>;
type RoadmapItemDetail = z.infer<typeof itemDetailSchema>;
type MutatedRoadmapItem = z.infer<typeof mutatedItemSchema>;

function toItem(raw: UpstreamItem): RoadmapItem {
  return {
    slug: raw.slug,
    title: raw.title,
    status: raw.status,
    url: itemUrl(raw.slug),
    upvoteCount: raw.upvote_count,
    commentCount: raw.comment_count,
    tags: raw.tags ?? [],
    viewerUpvoted: raw.viewer_upvoted ?? null,
  };
}

function toMutatedItem(raw: UpstreamMutatedItem): MutatedRoadmapItem {
  return {
    slug: raw.slug,
    title: raw.title,
    status: raw.status,
    url: itemUrl(raw.slug),
  };
}

function toItemDetail(raw: UpstreamItemDetail): RoadmapItemDetail {
  return {
    ...toItem(raw),
    description: raw.description ?? "",
    creatorUsername: raw.creator_username,
    creatorKind: raw.creator_kind ?? null,
    created: raw.created,
    comments: (raw.comments ?? []).map((c) => ({
      id: c.id,
      authorUsername: c.author_username,
      authorKind: c.author_kind ?? null,
      authorIsStaff: c.author_is_staff ?? false,
      body: c.body,
      created: c.created,
    })),
  };
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

function requireSlug({ pathParams = {} }: RouteHandlerArgs): string {
  const slug = pathParams.slug?.trim();
  if (!slug) {
    throw new BadRequestError(
      "slug is required. Run `assistant roadmap list` to find one.",
    );
  }
  return slug;
}

/** Body validated against a request schema, or the schema's own complaint. */
function parseBody<T>(
  schema: z.ZodType<T>,
  body: Record<string, unknown> | undefined,
): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.issues[0].message);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleList({
  queryParams = {},
  abortSignal,
}: RouteHandlerArgs): Promise<{
  items: RoadmapItem[];
  total: number;
}> {
  const response = await roadmapFetch("", {
    key: await assistantApiKey(),
    signal: abortSignal,
    params: {
      q: queryParams.q,
      status: queryParams.status,
      tag: queryParams.tag,
      sort: queryParams.sort,
      limit: queryParams.limit,
      offset: queryParams.offset,
    },
  });
  const data = await roadmapJson<{ items?: UpstreamItem[]; total?: number }>(
    response,
    "list roadmap items",
  );
  const items = (data.items ?? []).map(toItem);
  return { items, total: data.total ?? items.length };
}

async function handleGet(args: RouteHandlerArgs): Promise<RoadmapItemDetail> {
  const slug = requireSlug(args);
  const response = await roadmapFetch(`/${encodeURIComponent(slug)}`, {
    key: await assistantApiKey(),
    signal: args.abortSignal,
  });
  return toItemDetail(
    await roadmapJson<UpstreamItemDetail>(response, "get roadmap item"),
  );
}

async function handleCreate(
  args: RouteHandlerArgs,
): Promise<MutatedRoadmapItem> {
  const item = parseBody(createRequestSchema, args.body);
  const response = await roadmapFetch("", {
    method: "POST",
    key: await requireAssistantApiKey(),
    body: { ...item, title: item.title.trim() },
    signal: args.abortSignal,
  });
  return toMutatedItem(
    await roadmapJson<UpstreamMutatedItem>(response, "create roadmap item"),
  );
}

async function handleUpdate(
  args: RouteHandlerArgs,
): Promise<MutatedRoadmapItem> {
  const slug = requireSlug(args);
  const patch = parseBody(updateRequestSchema, args.body);
  const response = await roadmapFetch(`/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    key: await requireAssistantApiKey(),
    body: patch,
    signal: args.abortSignal,
  });
  return toMutatedItem(
    await roadmapJson<UpstreamMutatedItem>(response, "update roadmap item"),
  );
}

async function handleDelete(
  args: RouteHandlerArgs,
): Promise<{ slug: string; deleted: true }> {
  const slug = requireSlug(args);
  const response = await roadmapFetch(`/${encodeURIComponent(slug)}`, {
    method: "DELETE",
    key: await requireAssistantApiKey(),
    signal: args.abortSignal,
  });
  if (!response.ok) {
    await throwRoadmapError(response, "delete roadmap item");
  }
  return { slug, deleted: true };
}

async function vote(
  args: RouteHandlerArgs,
  method: "POST" | "DELETE",
  action: string,
): Promise<{ slug: string; upvoteCount: number }> {
  const slug = requireSlug(args);
  const response = await roadmapFetch(`/${encodeURIComponent(slug)}/upvote`, {
    method,
    key: await requireAssistantApiKey(),
    signal: args.abortSignal,
  });
  const data = await roadmapJson<{ slug?: string; upvote_count?: number }>(
    response,
    action,
  );
  return { slug: data.slug ?? slug, upvoteCount: data.upvote_count ?? 0 };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const SLUG_PARAM: RoutePathParam[] = [
  { name: "slug", description: "Roadmap item slug" },
];

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "roadmap_list",
    endpoint: "roadmap",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List public roadmap items",
    description:
      "Lists items from the public Vellum roadmap. Authenticated as the assistant when a platform API key is stored, which fills in viewerUpvoted; anonymous otherwise.",
    tags: ["roadmap"],
    queryParams: [
      { name: "q", required: false, description: "Search query" },
      { name: "status", required: false, description: "Filter by status" },
      { name: "tag", required: false, description: "Filter by tag slug" },
      {
        name: "sort",
        required: false,
        description: "Sort order: 'upvotes' or 'created'",
      },
      {
        name: "limit",
        type: "integer",
        required: false,
        description: "Maximum number of items to return",
      },
      {
        name: "offset",
        type: "integer",
        required: false,
        description: "Number of items to skip",
      },
    ],
    responseBody: z.object({
      items: z.array(itemSchema),
      total: z.number(),
    }),
    handler: handleList,
  },
  {
    operationId: "roadmap_get",
    endpoint: "roadmap/:slug",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get one roadmap item",
    description:
      "Returns a single roadmap item with its description and comment thread.",
    tags: ["roadmap"],
    pathParams: SLUG_PARAM,
    responseBody: itemDetailSchema,
    handler: handleGet,
  },
  {
    operationId: "roadmap_create",
    endpoint: "roadmap",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "File a roadmap item as the assistant",
    description:
      "Creates a publicly visible roadmap item attributed to the assistant. Requires a stored platform API key.",
    tags: ["roadmap"],
    requestBody: createRequestSchema,
    responseBody: mutatedItemSchema,
    handler: handleCreate,
  },
  {
    operationId: "roadmap_update",
    endpoint: "roadmap/:slug",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update a roadmap item",
    description:
      "Updates a roadmap item. At least one field is required; the roadmap service decides which items this assistant may edit.",
    tags: ["roadmap"],
    pathParams: SLUG_PARAM,
    requestBody: updateRequestSchema,
    responseBody: mutatedItemSchema,
    handler: handleUpdate,
  },
  {
    operationId: "roadmap_delete",
    endpoint: "roadmap/:slug",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete a roadmap item",
    description:
      "Permanently removes a roadmap item. The roadmap service decides which items this assistant may delete.",
    tags: ["roadmap"],
    pathParams: SLUG_PARAM,
    responseBody: z.object({
      slug: z.string(),
      deleted: z.literal(true),
    }),
    handler: handleDelete,
  },
  {
    operationId: "roadmap_upvote",
    endpoint: "roadmap/:slug/upvote",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Upvote a roadmap item as the assistant",
    description:
      "Adds the assistant's upvote. Idempotent: upvoting twice leaves the count unchanged.",
    tags: ["roadmap"],
    pathParams: SLUG_PARAM,
    responseBody: voteSchema,
    handler: (args) => vote(args, "POST", "upvote roadmap item"),
  },
  {
    operationId: "roadmap_unvote",
    endpoint: "roadmap/:slug/upvote",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Remove the assistant's upvote",
    description: "Removes the assistant's upvote from a roadmap item.",
    tags: ["roadmap"],
    pathParams: SLUG_PARAM,
    responseBody: voteSchema,
    handler: (args) => vote(args, "DELETE", "remove upvote"),
  },
];
