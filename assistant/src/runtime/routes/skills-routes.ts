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
  getSkillFiles,
  inspectSkill,
  installSkill,
  listSkills,
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

export function skillRouteDefinitions(deps: SkillRouteDeps): RouteDefinition[] {
  const ctx = () => deps.getSkillContext();

  return [
    {
      endpoint: "skills",
      method: "GET",
      policyKey: "skills",
      summary: "List all skills",
      description: "Return all installed skills.",
      tags: ["skills"],
      responseBody: z.object({
        skills: z.array(z.unknown()).describe("Skill objects"),
      }),
      handler: () => {
        const skills = listSkills(ctx());
        return Response.json({ skills });
      },
    },

    {
      endpoint: "skills/:id/files",
      method: "GET",
      policyKey: "skills",
      summary: "Get skill files",
      description: "Return skill metadata and directory contents.",
      tags: ["skills"],
      handler: ({ params }) => {
        const result = getSkillFiles(params.id, ctx());
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
      }),
      responseBody: z.object({
        ok: z.boolean(),
      }),
      handler: async ({ req }) => {
        const body = (await req.json()) as {
          slug?: string;
          url?: string;
          spec?: string;
          version?: string;
        };
        const slug = body.slug ?? body.url ?? body.spec;
        if (!slug || typeof slug !== "string") {
          return httpError(
            "BAD_REQUEST",
            "slug, url, or spec is required",
            400,
          );
        }
        const result = await installSkill(
          { slug, version: body.version },
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
        data: z.object({}).passthrough().describe("Search results"),
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
        return Response.json({ data: result.data });
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
      handler: async ({ req }) => {
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
        const result = await createSkill(body, ctx());
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
      description: "Return a single skill by ID.",
      tags: ["skills"],
      handler: ({ params }) => {
        const result = getSkill(params.id, ctx());
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
