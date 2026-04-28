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
import { BadRequestError, ForbiddenError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

function serializeGroup(group: ReturnType<typeof getGroup>) {
  if (!group) return null;
  return {
    id: group.id,
    name: group.name,
    sortPosition: group.sortPosition,
    isSystemGroup: group.isSystemGroup,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleListGroups() {
  const groups = listGroups();
  return { groups: groups.map(serializeGroup) };
}

function handleCreateGroup({ body = {} }: RouteHandlerArgs) {
  const name = body.name;
  if (!name || typeof name !== "string") {
    throw new BadRequestError("Missing or invalid name");
  }
  try {
    const group = createGroup(name);
    return serializeGroup(group);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes("sort_position must be >= 4")
    ) {
      throw new BadRequestError(
        "Too many custom groups — sort_position ceiling reached",
      );
    }
    throw err;
  }
}

function handleUpdateGroup({ pathParams = {}, body = {} }: RouteHandlerArgs) {
  const groupId = pathParams.groupId;
  const existing = getGroup(groupId);
  if (!existing) {
    throw new NotFoundError("Group not found");
  }
  const name = body.name as string | undefined;
  const sortPosition = body.sortPosition as number | undefined;
  if (name !== undefined && typeof name !== "string") {
    throw new BadRequestError("name must be a string");
  }
  if (sortPosition !== undefined && typeof sortPosition !== "number") {
    throw new BadRequestError("sortPosition must be a number");
  }
  if (existing.isSystemGroup && sortPosition !== undefined) {
    throw new ForbiddenError("System group sort position cannot be changed");
  }
  if (
    sortPosition !== undefined &&
    (typeof sortPosition !== "number" ||
      !isFinite(sortPosition) ||
      sortPosition < 4)
  ) {
    throw new BadRequestError("Custom group sort_position must be >= 4");
  }
  const updated = updateGroup(groupId, { name, sortPosition });
  if (!updated) {
    throw new NotFoundError("Group not found");
  }
  return serializeGroup(updated);
}

function handleDeleteGroup({ pathParams = {} }: RouteHandlerArgs) {
  const groupId = pathParams.groupId;
  const existing = getGroup(groupId);
  if (!existing) {
    throw new NotFoundError("Group not found");
  }
  if (existing.isSystemGroup) {
    throw new ForbiddenError("System groups cannot be deleted");
  }
  deleteGroup(groupId);
}

function handleReorderGroups({ body = {} }: RouteHandlerArgs) {
  const updates = body.updates as
    | Array<{ groupId: string; sortPosition: number }>
    | undefined;
  if (!Array.isArray(updates)) {
    throw new BadRequestError("Missing updates array");
  }
  for (const update of updates) {
    const group = getGroup(update.groupId);
    if (!group) continue;
    if (group.isSystemGroup) {
      throw new ForbiddenError(
        `Cannot reorder system group: ${update.groupId}`,
      );
    }
    if (
      typeof update.sortPosition !== "number" ||
      !isFinite(update.sortPosition) ||
      update.sortPosition < 4
    ) {
      throw new BadRequestError(
        `Custom group sort_position must be >= 4 (got ${update.sortPosition} for ${update.groupId})`,
      );
    }
  }
  reorderGroups(updates);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "groups_list",
    endpoint: "groups",
    method: "GET",
    policyKey: "groups",
    handler: handleListGroups,
    summary: "List groups",
    description: "Return all conversation groups.",
    tags: ["groups"],
  },
  {
    operationId: "groups_create",
    endpoint: "groups",
    method: "POST",
    policyKey: "groups",
    handler: handleCreateGroup,
    responseStatus: "201",
    summary: "Create group",
    description:
      "Create a new custom conversation group. Server assigns sort_position.",
    tags: ["groups"],
    requestBody: z.object({
      name: z.string().describe("Group name"),
    }),
    additionalResponses: {
      "400": {
        description:
          "Missing or invalid name, or sort_position ceiling reached",
      },
    },
  },
  {
    operationId: "groups_update",
    endpoint: "groups/:groupId",
    method: "PATCH",
    policyKey: "groups",
    handler: handleUpdateGroup,
    summary: "Update group",
    description: "Update a conversation group's name or sort position.",
    tags: ["groups"],
    requestBody: z.object({
      name: z.string().optional(),
      sortPosition: z.number().optional(),
    }),
    additionalResponses: {
      "403": {
        description: "System group sort position cannot be changed",
      },
      "404": {
        description: "Group not found",
      },
    },
  },
  {
    operationId: "groups_delete",
    endpoint: "groups/:groupId",
    method: "DELETE",
    policyKey: "groups",
    handler: handleDeleteGroup,
    responseStatus: "204",
    summary: "Delete group",
    description: "Delete a custom conversation group.",
    tags: ["groups"],
    additionalResponses: {
      "403": {
        description: "System groups cannot be deleted",
      },
      "404": {
        description: "Group not found",
      },
    },
  },
  {
    operationId: "groups_reorder",
    endpoint: "groups/reorder",
    method: "POST",
    policyKey: "groups/reorder",
    handler: handleReorderGroups,
    summary: "Reorder groups",
    description: "Batch-update sort positions for conversation groups.",
    tags: ["groups"],
    requestBody: z.object({
      updates: z
        .array(
          z.object({
            groupId: z.string(),
            sortPosition: z.number(),
          }),
        )
        .describe("Array of { groupId, sortPosition } objects"),
    }),
    additionalResponses: {
      "403": {
        description: "Cannot reorder system groups",
      },
    },
  },
];
