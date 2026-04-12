// Skill management types.

// === Client → Server ===

export interface SkillsListRequest {
  type: "skills_list";
}

export interface SkillDetailRequest {
  type: "skill_detail";
  skillId: string;
}

export interface SkillsEnableRequest {
  type: "skills_enable";
  name: string;
}

export interface SkillsDisableRequest {
  type: "skills_disable";
  name: string;
}

export interface SkillsConfigureRequest {
  type: "skills_configure";
  name: string;
  env?: Record<string, string>;
  apiKey?: string;
  config?: Record<string, unknown>;
}

export interface SkillsInstallRequest {
  type: "skills_install";
  slug: string;
  version?: string;
}

export interface SkillsUninstallRequest {
  type: "skills_uninstall";
  name: string;
}

export interface SkillsUpdateRequest {
  type: "skills_update";
  name: string;
}

export interface SkillsCheckUpdatesRequest {
  type: "skills_check_updates";
}

export interface SkillsSearchRequest {
  type: "skills_search";
  query: string;
}

export interface SkillsInspectRequest {
  type: "skills_inspect";
  slug: string;
}

export interface SkillsDraftRequest {
  type: "skills_draft";
  sourceText: string;
}

export interface SkillsCreateRequest {
  type: "skills_create";
  skillId: string;
  name: string;
  description: string;
  emoji?: string;
  bodyMarkdown: string;
  overwrite?: boolean;
}

// === Server → Client ===

/** Fields shared by all skill origins. */
interface SlimSkillBase {
  id: string;
  name: string;
  description: string;
  emoji?: string;
  kind: "bundled" | "installed" | "catalog";
  status: "enabled" | "disabled" | "available";
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
}

interface CustomSlimSkill extends SlimSkillBase {
  origin: "custom";
}

export type SlimSkillResponse =
  | VellumSlimSkill
  | ClawhubSlimSkill
  | SkillsshSlimSkill
  | CustomSlimSkill;

export interface SkillsListResponse {
  type: "skills_list_response";
  skills: SlimSkillResponse[];
}

export interface SkillStateChanged {
  type: "skills_state_changed";
  name: string;
  state: "enabled" | "disabled" | "installed" | "uninstalled";
}

export interface SkillBodyResponse {
  type: "skill_detail_response";
  skillId: string;
  body: string;
  icon?: string;
  error?: string;
}

// ─── Detail endpoint response (HTTP API) ──────────────────────────────────

interface SkillDetailBase {
  id: string;
  name: string;
  description: string;
  emoji?: string;
  kind: "bundled" | "installed" | "catalog";
  status: "enabled" | "disabled" | "available";
}

interface VellumSkillDetail extends SkillDetailBase {
  origin: "vellum";
}

interface ClawhubSkillDetail extends SkillDetailBase {
  origin: "clawhub";
  slug: string;
  author: string;
  stars: number;
  installs: number;
  reports: number;
  publishedAt?: string;
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
}

interface CustomSkillDetail extends SkillDetailBase {
  origin: "custom";
}

export type SkillDetailResponse =
  | VellumSkillDetail
  | ClawhubSkillDetail
  | SkillsshSkillDetail
  | CustomSkillDetail;

// ─── Single-file content response (HTTP API) ─────────────────────────────
export interface SkillFileContentResponse {
  path: string;
  name: string;
  size: number;
  mimeType: string;
  isBinary: boolean;
  content: string | null;
}

export interface SkillsDraftResponse {
  type: "skills_draft_response";
  success: boolean;
  draft?: {
    skillId: string;
    name: string;
    description: string;
    emoji?: string;
    bodyMarkdown: string;
  };
  warnings?: string[];
  error?: string;
}

export interface SkillsInspectResponse {
  type: "skills_inspect_response";
  slug: string;
  data?: {
    skill: { slug: string; displayName: string; summary: string };
    owner?: { handle: string; displayName: string; image?: string } | null;
    stats?: {
      stars: number;
      installs: number;
      downloads: number;
      versions: number;
    } | null;
    createdAt?: number | null;
    updatedAt?: number | null;
    latestVersion?: { version: string; changelog?: string } | null;
    files?: Array<{ path: string; size: number; contentType?: string }> | null;
    skillMdContent?: string | null;
  };
  error?: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _SkillsClientMessages =
  | SkillsListRequest
  | SkillDetailRequest
  | SkillsEnableRequest
  | SkillsDisableRequest
  | SkillsConfigureRequest
  | SkillsInstallRequest
  | SkillsUninstallRequest
  | SkillsUpdateRequest
  | SkillsCheckUpdatesRequest
  | SkillsSearchRequest
  | SkillsInspectRequest
  | SkillsDraftRequest
  | SkillsCreateRequest;

export type _SkillsServerMessages =
  | SkillsListResponse
  | SkillBodyResponse
  | SkillStateChanged
  | SkillsInspectResponse
  | SkillsDraftResponse;
