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
  inspectSkill,
  installSkill,
  listSkills,
  listSkillsFiltered,
  searchSkills,
  uninstallSkill,
  updateSkill,
} from "../../daemon/handlers/skills.js";
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
  emoji: z.string().optional(),
  kind: z.enum(["bundled", "installed", "catalog"]),
  status: z.enum(["enabled", "disabled", "available"]),
};

const slimSkillSchema = z.discriminatedUnion("origin", [
  z.object({ ...slimSkillBase, origin: z.literal("vellum") }),
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
  }),
  z.object({
    ...slimSkillBase,
    origin: z.literal("skillssh"),
    slug: z.string(),
    sourceRepo: z.string(),
    installs: z.number(),
    audit: z.record(z.string(), partnerAuditSchema).optional(),
  }),
  z.object({ ...slimSkillBase, origin: z.literal("custom") }),
]);

const skillDetailSchema = z.discriminatedUnion("origin", [
  z.object({ ...slimSkillBase, origin: z.literal("vellum") }),
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
  z.object({ ...slimSkillBase, origin: z.literal("custom") }),
]);

// ---------------------------------------------------------------------------
// Shared route definitions (HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listSkills",
    endpoint: "skills",
    method: "GET",
    policyKey: "skills",
    requirePolicyEnforcement: true,
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
          "Filter by skill origin (e.g. 'vellum', 'clawhub', 'skillssh', 'custom').",
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
        const result = await listSkillsFiltered(
          {
            ...(origin ? { origin } : {}),
            ...(kind ? { kind } : {}),
            ...(q ? { q } : {}),
            ...(category ? { category } : {}),
            includeCatalog: include === "catalog",
          },
        );
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
    operationId: "getSkillFileContent",
    endpoint: "skills/:id/files/content",
    method: "GET",
    policyKey: "skills",
    requirePolicyEnforcement: true,
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
    policyKey: "skills",
    requirePolicyEnforcement: true,
    summary: "Get skill files",
    description: "Return skill metadata and directory contents.",
    tags: ["skills"],
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
    policyKey: "skills",
    requirePolicyEnforcement: true,
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
    policyKey: "skills",
    requirePolicyEnforcement: true,
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
    policyKey: "skills",
    requirePolicyEnforcement: true,
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
      const result = configureSkill(
        pathParams!.id,
        {
          env: body.env as Record<string, string> | undefined,
          apiKey: body.apiKey as string | undefined,
          config: body.config as Record<string, unknown> | undefined,
        },
      );
      if (!result.success) throw new InternalError(result.error);
      return { ok: true };
    },
  },
  {
    operationId: "checkSkillUpdates",
    endpoint: "skills/check-updates",
    method: "POST",
    policyKey: "skills",
    requirePolicyEnforcement: true,
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
    policyKey: "skills",
    requirePolicyEnforcement: true,
    summary: "Search skill catalog",
    description: "Search the skill catalog by query string.",
    tags: ["skills"],
    queryParams: [
      {
        name: "q",
        schema: { type: "string" },
        description: "Search query (required)",
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
      const result = await searchSkills(query);
      if (!result.success) throw new InternalError(result.error);
      return { skills: result.skills };
    },
  },
  {
    operationId: "draftSkill",
    endpoint: "skills/draft",
    method: "POST",
    policyKey: "skills",
    requirePolicyEnforcement: true,
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
    policyKey: "skills",
    requirePolicyEnforcement: true,
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
    policyKey: "skills",
    requirePolicyEnforcement: true,
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
    policyKey: "skills",
    requirePolicyEnforcement: true,
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
    policyKey: "skills",
    requirePolicyEnforcement: true,
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
    policyKey: "skills",
    requirePolicyEnforcement: true,
    summary: "Install skill",
    description: "Install a skill by slug, URL, or spec.",
    tags: ["skills"],
    requestBody: z.object({
      slug: z.string().describe("Skill slug"),
      url: z.string().describe("Skill URL"),
      spec: z.string().describe("Skill spec"),
      version: z.string(),
      origin: z
        .enum(["clawhub", "skillssh"])
        .optional()
        .describe(
          "Which registry to install from. When omitted, the install flow auto-detects based on slug format.",
        ),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      skillId: z.string().optional(),
    }),
    handler: async ({ body = {} }: RouteHandlerArgs) => {
      const slug =
        (body.slug as string) ??
        (body.url as string) ??
        (body.spec as string);
      if (!slug || typeof slug !== "string") {
        throw new BadRequestError("slug, url, or spec is required");
      }
      const result = await installSkill(
        {
          slug,
          version: body.version as string | undefined,
          origin: body.origin as "clawhub" | "skillssh" | undefined,
        },
      );
      if (!result.success) throw new InternalError(result.error);
      return { ok: true, skillId: result.skillId };
    },
  },
  {
    operationId: "createSkill",
    endpoint: "skills",
    method: "POST",
    policyKey: "skills",
    requirePolicyEnforcement: true,
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
      const result = await createSkill(
        { skillId, name, description, bodyMarkdown },
      );
      if (!result.success) throw new InternalError(result.error);
      return { ok: true };
    },
  },
];
