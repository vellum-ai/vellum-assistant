// Skill management types.
//
// The `skills_state_changed` server event is single-sourced from its canonical
// `api/events` wire schema; the remaining exports are HTTP-API response shapes
// consumed by the skills routes.

import type { SkillStateChangedEvent } from "../../api/events/skill-state-changed.js";
import type { PartnerAudit } from "../../skills/skillssh-audit-types.js";
import type { OwnerInfo } from "../../tools/types.js";

// Re-export so consumers can access the audit types from this module.
export type { PartnerAudit } from "../../skills/skillssh-audit-types.js";

// Skill management (list, detail, install, enable/disable, …) is served by the
// HTTP skills routes, not by client messages.

// === Server → Client ===

/** Fields shared by all skill origins. */
interface SlimSkillBase {
  id: string;
  name: string;
  description: string;
  icon?: string;
  emoji?: string;
  kind: "bundled" | "installed" | "catalog";
  status: "enabled" | "disabled" | "available";
  category: string;
  /**
   * Extension that ships this skill, reusing the tool registry's
   * {@link OwnerInfo} model. Set for plugin-resident skills as
   * `{ kind: "plugin", id: <plugin dir name> }` so clients can attribute
   * them to the owning plugin instead of collapsing to their `kind`/`origin`.
   */
  owner?: OwnerInfo;
}

interface VellumSlimSkill extends SlimSkillBase {
  origin: "vellum";
}

interface ClawhubSlimSkill extends SlimSkillBase {
  origin: "clawhub";
  slug: string;
  author: string;
  stars: number;
  installs: number;
  reports: number;
  publishedAt?: string;
  version: string;
}

interface SkillsshSlimSkill extends SlimSkillBase {
  origin: "skillssh";
  slug: string;
  sourceRepo: string;
  installs: number;
  audit?: Record<string, PartnerAudit>;
}

interface CustomSlimSkill extends SlimSkillBase {
  origin: "custom";
}

/**
 * Managed skill authored by the assistant's retrospective. Identical shape to a
 * custom skill — it stays managed/deletable — but carries a distinct origin so
 * the UI badges it as "Assistant's Memory" instead of "Custom".
 */
interface AssistantMemorySlimSkill extends SlimSkillBase {
  origin: "assistant-memory";
}

export type SlimSkillResponse =
  | VellumSlimSkill
  | ClawhubSlimSkill
  | SkillsshSlimSkill
  | CustomSlimSkill
  | AssistantMemorySlimSkill;

export interface SkillsListFilteredResponse {
  type: "skills_list_response";
  skills: SlimSkillResponse[];
  categoryCounts: Record<string, number>;
  totalCount: number;
}

// ─── Detail endpoint response (HTTP API) ──────────────────────────────────

interface SkillDetailBase {
  id: string;
  name: string;
  description: string;
  icon?: string;
  emoji?: string;
  kind: "bundled" | "installed" | "catalog";
  status: "enabled" | "disabled" | "available";
  category: string;
}

interface VellumSkillDetail extends SkillDetailBase {
  origin: "vellum";
  /**
   * Extension that ships this skill, reusing the tool registry's
   * {@link OwnerInfo} model. Set for plugin-resident skills as
   * `{ kind: "plugin", id: <plugin dir name> }` — plugin skills are mapped to
   * the `vellum` origin, so this is where their attribution is preserved.
   */
  owner?: OwnerInfo;
}

interface ClawhubSkillDetail extends SkillDetailBase {
  origin: "clawhub";
  slug: string;
  author: string;
  stars: number;
  installs: number;
  reports: number;
  publishedAt?: string;
  version: string;
  // Enrichment fields (from clawhubInspect):
  owner?: { handle: string; displayName: string; image?: string } | null;
  stats?: {
    stars: number;
    installs: number;
    downloads: number;
    versions: number;
  } | null;
  latestVersion?: { version: string; changelog?: string } | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

interface SkillsshSkillDetail extends SkillDetailBase {
  origin: "skillssh";
  slug: string;
  sourceRepo: string;
  installs: number;
  audit?: Record<string, PartnerAudit>;
}

interface CustomSkillDetail extends SkillDetailBase {
  origin: "custom";
  /** See {@link VellumSkillDetail.owner}. */
  owner?: OwnerInfo;
}

/** Detail counterpart of {@link AssistantMemorySlimSkill}. */
interface AssistantMemorySkillDetail extends SkillDetailBase {
  origin: "assistant-memory";
  /** See {@link VellumSkillDetail.owner}. */
  owner?: OwnerInfo;
  /**
   * Conversation whose trace the retrospective distilled this skill from —
   * the durable lineage recorded in install-meta. Present only when the
   * scaffold recorded it; lets clients link back to the source conversation.
   */
  sourceConversationId?: string;
}

export type SkillDetailResponse =
  | VellumSkillDetail
  | ClawhubSkillDetail
  | SkillsshSkillDetail
  | CustomSkillDetail
  | AssistantMemorySkillDetail;

// ─── Single-file content response (HTTP API) ─────────────────────────────
export interface SkillFileContentResponse {
  path: string;
  name: string;
  size: number;
  mimeType: string;
  isBinary: boolean;
  content: string | null;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _SkillsServerMessages = SkillStateChangedEvent;
