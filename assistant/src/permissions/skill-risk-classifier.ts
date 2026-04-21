/**
 * Skill risk classifier — classifies skill tool invocations by risk level.
 *
 * Implements RiskClassifier<SkillClassifierInput> with constant risk levels
 * for each skill tool type:
 * - skill_load: Low (read-only skill loading)
 * - scaffold_managed_skill: High (writes persistent skill source code)
 * - delete_managed_skill: High (removes persistent skill source code)
 */

import type { RiskAssessment, RiskClassifier } from "./risk-types.js";

// ── Input type ───────────────────────────────────────────────────────────────

/** Input to the skill risk classifier. */
export interface SkillClassifierInput {
  /** Which skill tool is being invoked. */
  toolName: "skill_load" | "scaffold_managed_skill" | "delete_managed_skill";
  /** Optional skill selector (e.g. skill name or path). */
  skillSelector?: string;
}

// ── Classifier ───────────────────────────────────────────────────────────────

/**
 * Skill risk classifier implementation.
 *
 * Classifies skill tool invocations with constant risk levels per tool type.
 * checker.ts delegates to the singleton `skillLoadRiskClassifier` instance
 * for all skill tool risk classification.
 */
export class SkillLoadRiskClassifier implements RiskClassifier<SkillClassifierInput> {
  async classify(input: SkillClassifierInput): Promise<RiskAssessment> {
    switch (input.toolName) {
      case "skill_load":
        return {
          riskLevel: "low",
          reason: "Skill load (default)",
          scopeOptions: [],
          matchType: "registry",
        };
      case "scaffold_managed_skill":
        return {
          riskLevel: "high",
          reason: "Skill scaffold — writes persistent skill source code",
          scopeOptions: [],
          matchType: "registry",
        };
      case "delete_managed_skill":
        return {
          riskLevel: "high",
          reason: "Skill delete — removes persistent skill source code",
          scopeOptions: [],
          matchType: "registry",
        };
    }
  }
}

/** Singleton classifier instance. */
export const skillLoadRiskClassifier = new SkillLoadRiskClassifier();
