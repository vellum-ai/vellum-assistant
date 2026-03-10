/**
 * Route handlers for skill management operations.
 *
 * These HTTP routes expose the same business logic as the IPC skill handlers,
 * using the standalone functions extracted in `../../daemon/handlers/skills.ts`.
 */

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
    // GET /v1/skills — list all skills
    {
      endpoint: "skills",
      method: "GET",
      policyKey: "skills",
      handler: () => {
        const skills = listSkills(ctx());
        return Response.json({ skills });
      },
    },

    // POST /v1/skills/:id/enable — enable skill
    {
      endpoint: "skills/:id/enable",
      method: "POST",
      policyKey: "skills",
      handler: ({ params }) => {
        const result = enableSkill(params.id, ctx());
        if (!result.success) {
          return httpError("INTERNAL_ERROR", result.error, 500);
        }
        return Response.json({ ok: true });
      },
    },

    // POST /v1/skills/:id/disable — disable skill
    {
      endpoint: "skills/:id/disable",
      method: "POST",
      policyKey: "skills",
      handler: ({ params }) => {
        const result = disableSkill(params.id, ctx());
        if (!result.success) {
          return httpError("INTERNAL_ERROR", result.error, 500);
        }
        return Response.json({ ok: true });
      },
    },

    // PATCH /v1/skills/:id/config — configure skill
    {
      endpoint: "skills/:id/config",
      method: "PATCH",
      policyKey: "skills",
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

    // POST /v1/skills/install — install skill
    {
      endpoint: "skills/install",
      method: "POST",
      policyKey: "skills",
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

    // POST /v1/skills/check-updates — check for updates
    {
      endpoint: "skills/check-updates",
      method: "POST",
      policyKey: "skills",
      handler: async () => {
        const result = await checkSkillUpdates(ctx());
        if (!result.success) {
          return httpError("INTERNAL_ERROR", result.error, 500);
        }
        return Response.json({ data: result.data });
      },
    },

    // GET /v1/skills/search — search catalog
    {
      endpoint: "skills/search",
      method: "GET",
      policyKey: "skills",
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

    // POST /v1/skills/draft — draft new skill
    {
      endpoint: "skills/draft",
      method: "POST",
      policyKey: "skills",
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

    // POST /v1/skills — create skill
    {
      endpoint: "skills",
      method: "POST",
      policyKey: "skills",
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

    // POST /v1/skills/:id/update — update skill
    {
      endpoint: "skills/:id/update",
      method: "POST",
      policyKey: "skills",
      handler: async ({ params }) => {
        const result = await updateSkill(params.id, ctx());
        if (!result.success) {
          return httpError("INTERNAL_ERROR", result.error, 500);
        }
        return Response.json({ ok: true });
      },
    },

    // GET /v1/skills/:id/inspect — inspect skill details
    {
      endpoint: "skills/:id/inspect",
      method: "GET",
      policyKey: "skills",
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

    // DELETE /v1/skills/:id — uninstall skill
    {
      endpoint: "skills/:id",
      method: "DELETE",
      policyKey: "skills",
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
