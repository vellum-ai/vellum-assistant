/**
 * Route handlers for skill management operations.
 *
 * Shared ROUTES (13 routes) are served by both the HTTP server and IPC.
 * Routes requiring authContext remain HTTP-only via skillHttpOnlyRouteDefinitions().
 */

import { z } from "zod";

import {
  checkSkillUpdates,
  configureSkill,
  createSkill,
  disableSkill,
  draftSkill,
  enableSkill,
  getSkill,
  getSkillFileContent,
  getSkillFiles,
  getSkillLocalDetail,
  inspectSkill,
  installSkill,
  listSkills,
  listSkillsFiltered,
  searchSkills,
  uninstallSkill,
  updateSkill,
} from "../../daemon/handlers/skills.js";
import { getCategories } from "../../skills/categories-cache.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const partnerAuditSchema = z.object({
  risk: z.enum(["safe", "low", "medium", "high", "critical", "unknown"]),
  alerts: z.number().optional(),
  score: z.number().optional(),
  analyzedAt: z.string(),
});

const slimSkillBase = {
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string().optional(),
  emoji: z.string().optional(),
  kind: z.enum(["bundled", "installed", "catalog"]),
  status: z.enum(["enabled", "disabled", "available"]),
  category: z.string(),
};

// Extension that ships a skill, mirroring the tool registry's OwnerInfo.
// Plugin-resident skills carry `{ kind: "plugin", id: <plugin dir name> }` so
// clients can attribute them instead of collapsing to their kind/origin.
const skillOwnerSchema = z
  .object({
    kind: z.enum(["skill", "mcp", "plugin", "workspace"]),
    id: z.string(),
  })
  .optional();

const slimSkillBaseWithOwner = { ...slimSkillBase, owner: skillOwnerSchema };

const slimSkillSchema = z.discriminatedUnion("origin", [
  z.object({ ...slimSkillBaseWithOwner, origin: z.literal("vellum") }),
  z.object({
    ...slimSkillBaseWithOwner,
    origin: z.literal("clawhub"),
    slug: z.string(),
    author: z.string(),
    stars: z.number(),
    installs: z.number(),
    reports: z.number(),
    publishedAt: z.string().optional(),
    version: z.string(),
  }),
  z.object({
    ...slimSkillBaseWithOwner,
    origin: z.literal("skillssh"),
    slug: z.string(),
    sourceRepo: z.string(),
    installs: z.number(),
    audit: z.record(z.string(), partnerAuditSchema).optional(),
  }),
  z.object({ ...slimSkillBaseWithOwner, origin: z.literal("custom") }),
  // Managed skill authored by the assistant's retrospective. Same shape as
  // custom; the distinct origin only changes how the UI badges it.
  z.object({
    ...slimSkillBaseWithOwner,
    origin: z.literal("assistant-memory"),
  }),
]);

const skillDetailSchema = z.discriminatedUnion("origin", [
  z.object({ ...slimSkillBaseWithOwner, origin: z.literal("vellum") }),
  z.object({
    ...slimSkillBase,
    origin: z.literal("clawhub"),
    slug: z.string(),
    author: z.string(),
    stars: z.number(),
    installs: z.number(),
    reports: z.number(),
    publishedAt: z.string().optional(),
    version: z.string(),
    owner: z
      .object({
        handle: z.string(),
        displayName: z.string(),
        image: z.string().optional(),
      })
      .nullable()
      .optional(),
    stats: z
      .object({
        stars: z.number(),
        installs: z.number(),
        downloads: z.number(),
        versions: z.number(),
      })
      .nullable()
      .optional(),
    latestVersion: z
      .object({
        version: z.string(),
        changelog: z.string().optional(),
      })
      .nullable()
      .optional(),
    createdAt: z.number().nullable().optional(),
    updatedAt: z.number().nullable().optional(),
  }),
  z.object({
    ...slimSkillBase,
    origin: z.literal("skillssh"),
    slug: z.string(),
    sourceRepo: z.string(),
    installs: z.number(),
    audit: z.record(z.string(), partnerAuditSchema).optional(),
  }),
  z.object({ ...slimSkillBaseWithOwner, origin: z.literal("custom") }),
  z.object({
    ...slimSkillBaseWithOwner,
    origin: z.literal("assistant-memory"),
    sourceConversationId: z
      .string()
      .optional()
      .describe(
        "Conversation whose trace the retrospective distilled this skill from. Present only when recorded in install-meta.",
      ),
  }),
]);

// ---------------------------------------------------------------------------
// Shared route definitions (HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listSkills",
    endpoint: "skills",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List all skills",
    description:
      "Return all installed skills. Pass ?include=catalog to also include available catalog skills. Supports optional filter params: origin, kind, q, category.",
    tags: ["skills"],
    queryParams: [
      {
        name: "include",
        schema: { type: "string", enum: ["catalog"] },
        description:
          "Optional inclusion flag. Use 'catalog' to merge available Vellum catalog skills into the response.",
      },
      {
        name: "origin",
        schema: { type: "string" },
        description:
          "Filter by skill origin (e.g. 'vellum', 'clawhub', 'skillssh', 'custom', 'assistant-memory').",
      },
      {
        name: "kind",
        schema: { type: "string" },
        description:
          "Filter by kind: 'installed' (includes bundled), 'available', or pass through as skill.kind.",
      },
      {
        name: "q",
        schema: { type: "string" },
        description:
          "Text search across skill name, description, id, and origin label.",
      },
      {
        name: "category",
        schema: { type: "string" },
        description:
          "Filter by inferred category (e.g. 'communication', 'productivity').",
      },
    ],
    responseBody: z.object({
      skills: z.array(slimSkillSchema).describe("Skill objects"),
      categoryCounts: z
        .record(z.string(), z.number())
        .optional()
        .describe(
          "Count of skills per category (before category filter is applied)",
        ),
      totalCount: z
        .number()
        .optional()
        .describe("Total number of skills matching non-category filters"),
    }),
    handler: async ({ queryParams = {} }: RouteHandlerArgs) => {
      const include = queryParams.include;
      const origin = queryParams.origin;
      const kind = queryParams.kind;
      const q = queryParams.q;
      const category = queryParams.category;

      const hasFilter = !!(origin || kind || q || category);

      if (hasFilter || include === "catalog") {
        const result = await listSkillsFiltered({
          ...(origin ? { origin } : {}),
          ...(kind ? { kind } : {}),
          ...(q ? { q } : {}),
          ...(category ? { category } : {}),
          includeCatalog: include === "catalog",
        });
        return {
          skills: result.skills,
          categoryCounts: result.categoryCounts,
          totalCount: result.totalCount,
        };
      }

      const skills = listSkills();
      return { skills };
    },
  },
  {
    operationId: "listSkillCategories",
    endpoint: "skills/categories",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List skill categories",
    description:
      "Return all skill category definitions with labels, icons, and descriptions.",
    tags: ["skills"],
    responseBody: z.object({
      categories: z.array(
        z.object({
          slug: z.string(),
          label: z.string(),
          description: z.string(),
          icon: z.string(),
        }),
      ),
    }),
    handler: async () => {
      const categories = await getCategories();
      return { categories };
    },
  },
  {
    operationId: "getSkillFileContent",
    endpoint: "skills/:id/files/content",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get skill file content",
    description:
      "Return the content of a single file belonging to an installed or catalog skill.",
    tags: ["skills"],
    queryParams: [
      {
        name: "path",
        schema: { type: "string" },
        required: true,
        description: "Relative path of the file within the skill directory",
      },
    ],
    responseBody: z.object({
      path: z.string(),
      name: z.string(),
      size: z.number().int(),
      mimeType: z.string(),
      isBinary: z.boolean(),
      content: z.string().nullable(),
    }),
    handler: async ({ pathParams, queryParams = {} }: RouteHandlerArgs) => {
      const path = queryParams.path;
      if (!path) {
        throw new BadRequestError("path query parameter is required");
      }
      const result = await getSkillFileContent(pathParams!.id, path);
      if ("error" in result) {
        if (result.status === 400) throw new BadRequestError(result.error);
        if (result.status === 404) throw new NotFoundError(result.error);
        throw new InternalError(result.error);
      }
      return result;
    },
  },
  {
    operationId: "getSkillFiles",
    endpoint: "skills/:id/files",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get skill files",
    description: "Return skill metadata and directory contents.",
    tags: ["skills"],
    responseBody: z.object({
      skill: slimSkillSchema.describe("Skill metadata"),
      files: z
        .array(
          z.object({
            path: z.string(),
            name: z.string(),
            size: z.number().int(),
            mimeType: z.string(),
            isBinary: z.boolean(),
            content: z.string().nullable(),
          }),
        )
        .describe("Directory contents"),
    }),
    handler: async ({ pathParams }: RouteHandlerArgs) => {
      const result = await getSkillFiles(pathParams!.id);
      if ("error" in result) {
        if (result.status === 404) throw new NotFoundError(result.error);
        throw new InternalError(result.error);
      }
      return result;
    },
  },
  {
    operationId: "enableSkill",
    endpoint: "skills/:id/enable",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Enable skill",
    description: "Enable an installed skill.",
    tags: ["skills"],
    responseBody: z.object({ ok: z.boolean() }),
    handler: ({ pathParams }: RouteHandlerArgs) => {
      const result = enableSkill(pathParams!.id);
      if (!result.success) throw new InternalError(result.error);
      return { ok: true };
    },
  },
  {
    operationId: "disableSkill",
    endpoint: "skills/:id/disable",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Disable skill",
    description: "Disable an installed skill.",
    tags: ["skills"],
    responseBody: z.object({ ok: z.boolean() }),
    handler: ({ pathParams }: RouteHandlerArgs) => {
      const result = disableSkill(pathParams!.id);
      if (!result.success) throw new InternalError(result.error);
      return { ok: true };
    },
  },
  {
    operationId: "configureSkill",
    endpoint: "skills/:id/config",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Configure skill",
    description: "Update skill configuration (env, apiKey, config).",
    tags: ["skills"],
    requestBody: z.object({
      env: z.object({}).passthrough().describe("Environment variables"),
      apiKey: z.string(),
      config: z.object({}).passthrough().describe("Arbitrary config"),
    }),
    responseBody: z.object({ ok: z.boolean() }),
    handler: ({ pathParams, body = {} }: RouteHandlerArgs) => {
      const result = configureSkill(pathParams!.id, {
        env: body.env as Record<string, string> | undefined,
        apiKey: body.apiKey as string | undefined,
        config: body.config as Record<string, unknown> | undefined,
      });
      if (!result.success) throw new InternalError(result.error);
      return { ok: true };
    },
  },
  {
    operationId: "checkSkillUpdates",
    endpoint: "skills/check-updates",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Check skill updates",
    description: "Check for available updates to installed skills.",
    tags: ["skills"],
    responseBody: z.object({
      data: z.object({}).passthrough().describe("Update availability info"),
    }),
    handler: async () => {
      const result = await checkSkillUpdates();
      if (!result.success) throw new InternalError(result.error);
      return { data: result.data };
    },
  },
  {
    operationId: "searchSkills",
    endpoint: "skills/search",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Search skill catalog",
    description: "Search the skill catalog by query string.",
    tags: ["skills"],
    queryParams: [
      {
        name: "q",
        schema: { type: "string" },
        description: "Search query (required)",
      },
      {
        name: "limit",
        schema: { type: "string" },
        description: "Max community results to fetch (default 25)",
      },
    ],
    responseBody: z.object({
      skills: z
        .array(slimSkillSchema)
        .describe("Skill objects matching the search query"),
    }),
    handler: async ({ queryParams = {} }: RouteHandlerArgs) => {
      const query = queryParams.q ?? "";
      if (!query) throw new BadRequestError("q query parameter is required");
      const limitRaw = queryParams.limit;
      const limit = limitRaw
        ? Math.max(1, Number.parseInt(limitRaw, 10) || 25)
        : 25;
      const result = await searchSkills(query, limit);
      if (!result.success) throw new InternalError(result.error);
      return { skills: result.skills };
    },
  },
  {
    operationId: "draftSkill",
    endpoint: "skills/draft",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Draft a skill",
    description: "Generate a skill draft from source text.",
    tags: ["skills"],
    requestBody: z.object({
      sourceText: z.string().describe("Source text for drafting"),
    }),
    handler: async ({ body = {} }: RouteHandlerArgs) => {
      const sourceText = body.sourceText as string | undefined;
      if (!sourceText || typeof sourceText !== "string") {
        throw new BadRequestError("sourceText is required");
      }
      const result = await draftSkill({ sourceText });
      if (!result.success) {
        throw new InternalError(result.error ?? "Draft failed");
      }
      return result;
    },
  },
  {
    operationId: "updateSkill",
    endpoint: "skills/:id/update",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update skill",
    description: "Update an installed skill to the latest version.",
    tags: ["skills"],
    responseBody: z.object({ ok: z.boolean() }),
    handler: async ({ pathParams }: RouteHandlerArgs) => {
      const result = await updateSkill(pathParams!.id);
      if (!result.success) throw new InternalError(result.error);
      return { ok: true };
    },
  },
  {
    operationId: "inspectSkill",
    endpoint: "skills/:id/inspect",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Inspect skill",
    description: "Return detailed skill information.",
    tags: ["skills"],
    handler: async ({ pathParams }: RouteHandlerArgs) => {
      const result = await inspectSkill(pathParams!.id);
      if (result.error && !result.data) {
        if (result.error.startsWith("Invalid skill slug:")) {
          throw new BadRequestError(result.error);
        }
        if (
          /not found|does not exist|no such skill|unknown skill/i.test(
            result.error,
          )
        ) {
          throw new NotFoundError(result.error);
        }
        throw new InternalError(result.error);
      }
      return result;
    },
  },
  {
    operationId: "getSkill",
    endpoint: "skills/:id",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get skill",
    description: "Return a single skill by ID with enriched detail fields.",
    tags: ["skills"],
    responseBody: z.object({
      skill: skillDetailSchema.describe("Skill detail object"),
    }),
    handler: async ({ pathParams }: RouteHandlerArgs) => {
      const result = await getSkill(pathParams!.id);
      if ("error" in result) {
        if (result.status === 404) throw new NotFoundError(result.error);
        throw new InternalError(result.error);
      }
      return result;
    },
  },
  {
    operationId: "deleteSkill",
    endpoint: "skills/:id",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Uninstall skill",
    description: "Remove an installed skill.",
    tags: ["skills"],
    responseStatus: "204",
    handler: async ({ pathParams }: RouteHandlerArgs) => {
      const result = await uninstallSkill(pathParams!.id);
      if (!result.success) throw new InternalError(result.error);
      return null;
    },
  },
  {
    operationId: "installSkill",
    endpoint: "skills/install",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Install skill",
    description: "Install a skill by slug, URL, or spec.",
    tags: ["skills"],
    requestBody: z.object({
      slug: z
        .string()
        .optional()
        .describe("Skill slug. One of slug, url, or spec is required."),
      url: z
        .string()
        .optional()
        .describe("Skill URL. One of slug, url, or spec is required."),
      spec: z
        .string()
        .optional()
        .describe("Skill spec. One of slug, url, or spec is required."),
      version: z.string().optional().describe("Specific version to install"),
      origin: z
        .enum(["clawhub", "skillssh"])
        .optional()
        .describe(
          "Which registry to install from. When omitted, the install flow auto-detects based on slug format.",
        ),
      overwrite: z
        .boolean()
        .optional()
        .describe(
          "Replace an existing install. Defaults to true for back-compat with the legacy in-process API.",
        ),
      catalogOnly: z
        .boolean()
        .optional()
        .describe(
          "When true, restrict to bundled and Vellum catalog skills only — do not fall through to community registries.",
        ),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      skillId: z.string().optional(),
    }),
    handler: async ({ body = {} }: RouteHandlerArgs) => {
      const slug =
        (body.slug as string) ?? (body.url as string) ?? (body.spec as string);
      if (!slug || typeof slug !== "string") {
        throw new BadRequestError("slug, url, or spec is required");
      }
      const result = await installSkill({
        slug,
        version: body.version as string | undefined,
        origin: body.origin as "clawhub" | "skillssh" | undefined,
        catalogOnly: body.catalogOnly as boolean | undefined,
        overwrite: body.overwrite as boolean | undefined,
      });
      if (!result.success) throw new InternalError(result.error);
      return { ok: true, skillId: result.skillId };
    },
  },
  {
    operationId: "createSkill",
    endpoint: "skills",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Create skill",
    description: "Create a new skill.",
    tags: ["skills"],
    requestBody: z.object({
      skillId: z.string(),
      name: z.string(),
      description: z.string(),
      bodyMarkdown: z.string(),
    }),
    responseBody: z.object({ ok: z.boolean() }),
    responseStatus: "201",
    handler: async ({ body = {} }: RouteHandlerArgs) => {
      const { skillId, name, description, bodyMarkdown } = body as Record<
        string,
        string
      >;
      if (!skillId || !name || !description || !bodyMarkdown) {
        throw new BadRequestError(
          "skillId, name, description, and bodyMarkdown are required",
        );
      }
      const result = await createSkill({
        skillId,
        name,
        description,
        bodyMarkdown,
      });
      if (!result.success) throw new InternalError(result.error);
      return { ok: true };
    },
  },
  {
    operationId: "skillsLocalInspect",
    endpoint: "skills/:id/local-inspect",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Local skill inspect",
    description:
      "Return full local detail for an installed or bundled skill, including featureFlag, toolManifest, installMeta, configEntry, and directoryPath.",
    tags: ["skills"],
    handler: ({ pathParams }: RouteHandlerArgs) => {
      const result = getSkillLocalDetail(pathParams!.id);
      if (!result.ok) {
        if (result.status === 404) throw new NotFoundError(result.error);
        throw new InternalError(result.error);
      }
      return result;
    },
  },
];
