import type { SkillSummary } from "../config/skills.js";
import type { CatalogSkill } from "./catalog-install.js";

/**
 * Generic input for building capability statements.
 * Decoupled from CatalogSkill so other skill sources (e.g. bundled skills) can
 * produce capability memories without being shoehorned into the catalog type.
 */
export interface SkillCapabilityInput {
  id: string;
  displayName: string;
  description: string;
  activationHints?: string[];
  avoidWhen?: string[];
}

/**
 * Convert a SkillSummary to a SkillCapabilityInput.
 * SkillSummary already has flat properties, so this is a straightforward mapping.
 */
export function fromSkillSummary(entry: SkillSummary): SkillCapabilityInput {
  return {
    id: entry.id,
    displayName: entry.displayName,
    description: entry.description,
    activationHints: entry.activationHints,
    avoidWhen: entry.avoidWhen,
  };
}

/**
 * Convert a CatalogSkill to a SkillCapabilityInput.
 * CatalogSkill stores display-name and hints inside nested metadata.
 */
export function fromCatalogSkill(entry: CatalogSkill): SkillCapabilityInput {
  return {
    id: entry.id,
    displayName: entry.metadata?.vellum?.["display-name"] ?? entry.name,
    description: entry.description,
    activationHints: entry.metadata?.vellum?.["activation-hints"],
    avoidWhen: entry.metadata?.vellum?.["avoid-when"],
  };
}

