import {
  type ConversationGroupRow,
  listGroups,
} from "../../persistence/group-crud.js";

/**
 * Resolve a model-supplied group reference (id or name) against the current
 * group list. Name matching is case-insensitive on the trimmed input; an id
 * match always wins. Returns an error string (for the tool result) when the
 * reference is missing or ambiguous.
 */
export function resolveGroupReference(
  reference: string,
): { group: ConversationGroupRow } | { error: string } {
  const groups = listGroups();
  const trimmed = reference.trim();

  const byId = groups.find((g) => g.id === trimmed);
  if (byId) {
    return { group: byId };
  }

  const lowered = trimmed.toLowerCase();
  const byName = groups.filter((g) => g.name.trim().toLowerCase() === lowered);
  if (byName.length === 1) {
    return { group: byName[0] };
  }
  if (byName.length > 1) {
    return {
      error:
        `Group name "${trimmed}" is ambiguous. Matching groups:\n` +
        byName.map((g) => `- ${g.name} (id: ${g.id})`).join("\n") +
        "\nRetry with the group id.",
    };
  }

  return {
    error:
      `No group named "${trimmed}". Available groups:\n` +
      formatGroupList(groups) +
      "\nUse conversation_group_create to create a new group.",
  };
}

export function formatGroupList(groups: ConversationGroupRow[]): string {
  return groups
    .map(
      (g) =>
        `- ${g.name} (id: ${g.id})${g.isSystemGroup ? " [system group]" : ""}`,
    )
    .join("\n");
}
