/**
 * Route handlers for skill management operations.
 *
 * These HTTP routes expose the same business logic as the skill handlers,
 * using the standalone functions extracted in `../../daemon/handlers/skills.ts`.
 */

import { z } from "zod";

import type {
  CreateSkillParams,
  SkillOperationContext,
} from "../../daemon/handlers/skills.js";
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
  listSkillsWithCatalog,
  searchSkills,
  uninstallSkill,
  updateSkill,
} from "../../daemon/handlers/skills.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

/**
 * Dependencies injected by the HTTP server to provide the
 * SkillOperationContext that the business-logic functions need.
 */
export interface SkillRouteDeps {
  getSkillContext: () => SkillOperationContext;
}

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

export function skillRouteDefinitions(deps: SkillRouteDeps): RouteDefinition[] {
  const ctx = () => deps.getSkillContext();

  return [
    {
      endpoint: "skills",
      method: "GET",
      policyKey: "skills",
      summary: "List all skills",
      description:
        "Return all installed skills. Pass ?include=catalog to also include available catalog skills.",
      tags: ["skills"],
      queryParams: [
        {
          name: "include",
          schema: { type: "string", enum: ["catalog"] },
          description:
            "Optional inclusion flag. Use 'catalog' to merge available Vellum catalog skills into the response.",
        },
      ],
      responseBody: z.object({
        skills: z.array(slimSkillSchema).describe("Skill objects"),
      }),
      handler: async ({ url }) => {
        const include = url.searchParams.get("include");
        const skills =
          include === "catalog"
            ? await listSkillsWithCatalog(ctx())
            : listSkills(ctx());
        return Response.json({ skills });
      },
    },

    // The router uses strict anchored-regex matching, so this route is never
    // ambiguous with skills/:id/files.
    {
      endpoint: "skills/:id/files/content",
      method: "GET",
      policyKey: "skills",
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
      handler: async ({ params, url }) => {
        const path = url.searchParams.get("path");
        if (!path) {
          return httpError(
            "BAD_REQUEST",
            "path query parameter is required",
            400,
          );
        }
        const result = await getSkillFileContent(params.id, path, ctx());
        if ("error" in result) {
          if (result.status === 400) {
            return httpError("BAD_REQUEST", result.error, 400);
          }
          if (result.status === 404) {
            return httpError("NOT_FOUND", result.error, 404);
          }
          return httpError("INTERNAL_ERROR", result.error, 500);
        }
        return Response.json(result);
      },
    },

    {
      endpoint: "skills/:id/files",
      method: "GET",
      policyKey: "skills",
      summary: "Get skill files",
      description: "Return skill metadata and directory contents.",
      tags: ["skills"],
      handler: async ({ params }) => {
        const result = await getSkillFiles(params.id, ctx());
        if ("error" in result) {
          if (result.status === 404) {
            return httpError("NOT_FOUND", result.error, 404);
          }
          return httpError("INTERNAL_ERROR", result.error, 500);
        }
        return Response.json(result);
      },
    },

    {
      endpoint: "skills/:id/enable",
      method: "POST",
      policyKey: "skills",
      summary: "Enable skill",
      description: "Enable an installed skill.",
      tags: ["skills"],
      responseBody: z.object({
        ok: z.boolean(),
      }),
      handler: ({ params }) => {
        const result = enableSkill(params.id, ctx());
        if (!result.success) {
          return httpError("INTERNAL_ERROR", result.error, 500);
        }
        return Response.json({ ok: true });
      },
    },

    {
      endpoint: "skills/:id/disable",
      method: "POST",
      policyKey: "skills",
      summary: "Disable skill",
      description: "Disable an installed skill.",
      tags: ["skills"],
      responseBody: z.object({
        ok: z.boolean(),
      }),
      handler: ({ params }) => {
        const result = disableSkill(params.id, ctx());
        if (!result.success) {
          return httpError("INTERNAL_ERROR", result.error, 500);
        }
        return Response.json({ ok: true });
      },
    },

    {
      endpoint: "skills/:id/config",
      method: "PATCH",
      policyKey: "skills",
      summary: "Configure skill",
      description: "Update skill configuration (env, apiKey, config).",
      tags: ["skills"],
      requestBody: z.object({
        env: z.object({}).passthrough().describe("Environment variables"),
        apiKey: z.string(),
        config: z.object({}).passthrough().describe("Arbitrary config"),
      }),
      responseBody: z.object({
        ok: z.boolean(),
      }),
      handler: async ({ req, params }) => {
        const body = (await req.json()) as {
          env?: Record<string, string>;
          apiKey?: string;
          config?: Record<string, unknown>;
        };
        const result = configureSkill(
          params.id,
          { env: body.env, apiKey: body.apiKey, config: body.config },
          ctx(),
        );
        if (!result.success) {
          return httpError("INTERNAL_ERROR", result.error, 500);
        }
        return Response.json({ ok: true });
      },
    },

    {
      endpoint: "skills/install",
      method: "POST",
      policyKey: "skills",
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
      }),
      handler: async ({ req, authContext }) => {
        const body = (await req.json()) as {
          slug?: string;
          url?: string;
          spec?: string;
          version?: string;
          origin?: "clawhub" | "skillssh";
        };
        const slug = body.slug ?? body.url ?? body.spec;
        if (!slug || typeof slug !== "string") {
          return httpError(
            "BAD_REQUEST",
            "slug, url, or spec is required",
            400,
          );
        }
        const contactId = authContext.actorPrincipalId ?? undefined;
        const result = await installSkill(
          { slug, version: body.version, origin: body.origin, contactId },
          ctx(),
        );
        if (!result.success) {
          return httpError("INTERNAL_ERROR", result.error, 500);
        }
        return Response.json({ ok: true });
      },
    },

    {
      endpoint: "skills/check-updates",
      method: "POST",
      policyKey: "skills",
      summary: "Check skill updates",
      description: "Check for available updates to installed skills.",
      tags: ["skills"],
      responseBody: z.object({
        data: z.object({}).passthrough().describe("Update availability info"),
      }),
      handler: async () => {
        const result = await checkSkillUpdates(ctx());
        if (!result.success) {
          return httpError("INTERNAL_ERROR", result.error, 500);
        }
        return Response.json({ data: result.data });
      },
    },

    {
      endpoint: "skills/search",
      method: "GET",
      policyKey: "skills",
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
      handler: async ({ url }) => {
        const query = url.searchParams.get("q") ?? "";
        if (!query) {
          return httpError("BAD_REQUEST", "q query parameter is required", 400);
        }
        const result = await searchSkills(query, ctx());
        if (!result.success) {
          return httpError("INTERNAL_ERROR", result.error, 500);
        }
        return Response.json({ skills: result.skills });
      },
    },

    {
      endpoint: "skills/draft",
      method: "POST",
      policyKey: "skills",
      summary: "Draft a skill",
      description: "Generate a skill draft from source text.",
      tags: ["skills"],
      requestBody: z.object({
        sourceText: z.string().describe("Source text for drafting"),
      }),
      handler: async ({ req }) => {
        const body = (await req.json()) as { sourceText?: string };
        if (!body.sourceText || typeof body.sourceText !== "string") {
          return httpError("BAD_REQUEST", "sourceText is required", 400);
        }
        const result = await draftSkill({ sourceText: body.sourceText }, ctx());
        if (!result.success) {
          return httpError(
            "INTERNAL_ERROR",
            result.error ?? "Draft failed",
            500,
          );
        }
        return Response.json(result);
      },
    },

    {
      endpoint: "skills",
      method: "POST",
      policyKey: "skills",
      summary: "Create skill",
      description: "Create a new skill.",
      tags: ["skills"],
      requestBody: z.object({
        skillId: z.string(),
        name: z.string(),
        description: z.string(),
        bodyMarkdown: z.string(),
      }),
      responseBody: z.object({
        ok: z.boolean(),
      }),
      handler: async ({ req, authContext }) => {
        const body = (await req.json()) as CreateSkillParams;
        if (
          !body.skillId ||
          !body.name ||
          !body.description ||
          !body.bodyMarkdown
        ) {
          return httpError(
            "BAD_REQUEST",
            "skillId, name, description, and bodyMarkdown are required",
            400,
          );
        }
        const contactId = authContext.actorPrincipalId ?? undefined;
        const result = await createSkill({ ...body, contactId }, ctx());
        if (!result.success) {
          return httpError("INTERNAL_ERROR", result.error, 500);
        }
        return Response.json({ ok: true }, { status: 201 });
      },
    },

    {
      endpoint: "skills/:id/update",
      method: "POST",
      policyKey: "skills",
      summary: "Update skill",
      description: "Update an installed skill to the latest version.",
      tags: ["skills"],
      responseBody: z.object({
        ok: z.boolean(),
      }),
      handler: async ({ params }) => {
        const result = await updateSkill(params.id, ctx());
        if (!result.success) {
          return httpError("INTERNAL_ERROR", result.error, 500);
        }
        return Response.json({ ok: true });
      },
    },

    {
      endpoint: "skills/:id/inspect",
      method: "GET",
      policyKey: "skills",
      summary: "Inspect skill",
      description: "Return detailed skill information.",
      tags: ["skills"],
      handler: async ({ params }) => {
        const result = await inspectSkill(params.id, ctx());
        if (result.error && !result.data) {
          if (result.error.startsWith("Invalid skill slug:")) {
            return httpError("BAD_REQUEST", result.error, 400);
          }
          if (
            /not found|does not exist|no such skill|unknown skill/i.test(
              result.error,
            )
          ) {
            return httpError("NOT_FOUND", result.error, 404);
          }
          return httpError("INTERNAL_ERROR", result.error, 500);
        }
        return Response.json(result);
      },
    },

    {
      endpoint: "skills/:id",
      method: "GET",
      policyKey: "skills",
      summary: "Get skill",
      description: "Return a single skill by ID with enriched detail fields.",
      tags: ["skills"],
      responseBody: z.object({
        skill: skillDetailSchema.describe("Skill detail object"),
      }),
      handler: async ({ params }) => {
        const result = await getSkill(params.id, ctx());
        if ("error" in result) {
          if (result.status === 404) {
            return httpError("NOT_FOUND", result.error, 404);
          }
          return httpError("INTERNAL_ERROR", result.error, 500);
        }
        return Response.json(result);
      },
    },

    {
      endpoint: "skills/:id",
      method: "DELETE",
      policyKey: "skills",
      summary: "Uninstall skill",
      description: "Remove an installed skill.",
      tags: ["skills"],
      handler: async ({ params }) => {
        const result = await uninstallSkill(params.id, ctx());
        if (!result.success) {
          return httpError("INTERNAL_ERROR", result.error, 500);
        }
        return new Response(null, { status: 204 });
      },
    },
  ];
}
