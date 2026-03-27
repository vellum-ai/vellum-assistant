/**
 * Route handlers for conversation group management.
 *
 * GET    /v1/groups              — list all groups
 * POST   /v1/groups              — create a custom group
 * PATCH  /v1/groups/:groupId     — update a group
 * DELETE /v1/groups/:groupId     — delete a group
 * POST   /v1/groups/reorder      — reorder groups
 */

import { z } from "zod";

import {
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  reorderGroups,
  updateGroup,
} from "../../memory/group-crud.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

function serializeGroup(group: ReturnType<typeof getGroup>) {
  if (!group) return null;
  return {
    id: group.id,
    name: group.name,
    sortPosition: group.sortPosition,
    isSystemGroup: group.isSystemGroup,
  };
}

export function groupRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "groups",
      method: "GET",
      policyKey: "groups",
      summary: "List groups",
      description: "Return all conversation groups.",
      tags: ["groups"],
      handler: () => {
        const groups = listGroups();
        return Response.json({
          groups: groups.map(serializeGroup),
        });
      },
    },
    {
      endpoint: "groups",
      method: "POST",
      policyKey: "groups",
      summary: "Create group",
      description:
        "Create a new custom conversation group. Server assigns sort_position.",
      tags: ["groups"],
      requestBody: z.object({
        name: z.string().describe("Group name"),
      }),
      handler: async ({ req }) => {
        const body = (await req.json()) as { name?: string };
        if (!body.name || typeof body.name !== "string") {
          return httpError("BAD_REQUEST", "Missing or invalid name", 400);
        }
        const group = createGroup(body.name);
        return Response.json(serializeGroup(group), { status: 201 });
      },
    },
    {
      endpoint: "groups/:groupId",
      method: "PATCH",
      policyKey: "groups",
      summary: "Update group",
      description: "Update a conversation group's name or sort position.",
      tags: ["groups"],
      handler: async ({ req, params }) => {
        const groupId = params.groupId;
        const existing = getGroup(groupId);
        if (!existing) {
          return httpError("NOT_FOUND", "Group not found", 404);
        }
        // System groups are immutable
        if (existing.isSystemGroup) {
          return httpError(
            "FORBIDDEN",
            "System groups cannot be modified",
            403,
          );
        }
        const body = (await req.json()) as {
          name?: string;
          sortPosition?: number;
        };
        // Custom group sort_position must be >= 3
        if (body.sortPosition !== undefined && body.sortPosition < 3) {
          return httpError(
            "BAD_REQUEST",
            "Custom group sort_position must be >= 3",
            400,
          );
        }
        const updated = updateGroup(groupId, {
          name: body.name,
          sortPosition: body.sortPosition,
        });
        if (!updated) {
          return httpError("NOT_FOUND", "Group not found", 404);
        }
        return Response.json(serializeGroup(updated));
      },
    },
    {
      endpoint: "groups/:groupId",
      method: "DELETE",
      policyKey: "groups",
      summary: "Delete group",
      description: "Delete a custom conversation group.",
      tags: ["groups"],
      handler: ({ params }) => {
        const groupId = params.groupId;
        const existing = getGroup(groupId);
        if (!existing) {
          return httpError("NOT_FOUND", "Group not found", 404);
        }
        // System groups cannot be deleted
        if (existing.isSystemGroup) {
          return httpError("FORBIDDEN", "System groups cannot be deleted", 403);
        }
        deleteGroup(groupId);
        return new Response(null, { status: 204 });
      },
    },
    {
      endpoint: "groups/reorder",
      method: "POST",
      policyKey: "groups/reorder",
      summary: "Reorder groups",
      description: "Batch-update sort positions for conversation groups.",
      tags: ["groups"],
      requestBody: z.object({
        updates: z
          .array(z.unknown())
          .describe("Array of { groupId, sortPosition } objects"),
      }),
      handler: async ({ req }) => {
        const body = (await req.json()) as {
          updates?: Array<{
            groupId: string;
            sortPosition: number;
          }>;
        };
        if (!Array.isArray(body.updates)) {
          return httpError("BAD_REQUEST", "Missing updates array", 400);
        }
        // Validate: no system group reordering, no sort_position < 3 for custom groups
        for (const update of body.updates) {
          const group = getGroup(update.groupId);
          if (!group) continue;
          if (group.isSystemGroup) {
            return httpError(
              "FORBIDDEN",
              `Cannot reorder system group: ${update.groupId}`,
              403,
            );
          }
          if (update.sortPosition < 3) {
            return httpError(
              "BAD_REQUEST",
              `Custom group sort_position must be >= 3 (got ${update.sortPosition} for ${update.groupId})`,
              400,
            );
          }
        }
        reorderGroups(body.updates);
        return Response.json({ ok: true });
      },
    },
  ];
}
