import { createHash } from "node:crypto";

import type { SkillSummary } from "../config/skills.js";
import { validateIncludes } from "./include-graph.js";
import { computeSkillVersionHash } from "./version-hash.js";

/**
 * Error thrown when the include graph is invalid (missing nodes or cycles).
 * The permission layer depends on exact approval candidates, so we fail closed
 * rather than returning a partial or potentially misleading hash.
 */
export class TransitiveHashError extends Error {
  constructor(
    message: string,
    public readonly code: "missing" | "cycle",
  ) {
    super(message);
    this.name = "TransitiveHashError";
  }
}

/**
 * Compute a transitive version hash for a skill and all its included children.
 *
 * The hash covers:
 * 1. The DFS-ordered list of visited skill IDs (so the graph structure matters)
 * 2. Each visited skill's directory hash (via `computeSkillVersionHash`)
 *
 * This means editing any included child skill invalidates the parent's
 * transitive hash, which is required for version-pinned inline-command
 * approval.
 *
 * Fails closed (throws `TransitiveHashError`) when:
 * - A child referenced in `includes` is missing from the catalog index
 * - The include graph contains a cycle
 *
 * @param rootSkillId  The skill ID to start traversal from.
 * @param catalogIndex A `Map<skillId, SkillSummary>` built via `indexCatalogById`.
 * @returns A canonical hash string in the format `tv1:<hex-sha256>`.
 */
export function computeTransitiveSkillVersionHash(
  rootSkillId: string,
  catalogIndex: Map<string, SkillSummary>,
): string {
  // Validate the include graph first — fail closed on any issue.
  const validation = validateIncludes(rootSkillId, catalogIndex);

  if (!validation.ok) {
    if (validation.error === "cycle") {
      throw new TransitiveHashError(
        `Cycle detected in include graph: ${validation.cyclePath.join(" -> ")}`,
        "cycle",
      );
    }
    // validation.error === "missing"
    throw new TransitiveHashError(
      `Missing child skill "${validation.missingChildId}" referenced by "${validation.parentId}" (path: ${validation.path.join(" -> ")})`,
      "missing",
    );
  }

  // validation.ok === true, so visited contains all skill IDs in DFS pre-order.
  const { visited } = validation;

  const hash = createHash("sha256");

  for (const skillId of visited) {
    // Fold the skill ID into the digest so graph structure matters.
    hash.update(skillId);
    hash.update("\0");

    const skill = catalogIndex.get(skillId);
    if (!skill) {
      // Should be unreachable after validateIncludes succeeds, but fail closed.
      throw new TransitiveHashError(
        `Skill "${skillId}" disappeared from catalog index after validation`,
        "missing",
      );
    }

    // Fold the per-directory content hash so file changes propagate.
    const dirHash = computeSkillVersionHash(skill.directoryPath);
    hash.update(dirHash);
    hash.update("\n");
  }

  return `tv1:${hash.digest("hex")}`;
}
