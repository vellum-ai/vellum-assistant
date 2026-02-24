// Skill management types.

// === Client → Server ===

export interface SkillsListRequest {
  type: 'skills_list';
}

export interface SkillDetailRequest {
  type: 'skill_detail';
  skillId: string;
}

export interface SkillsEnableRequest {
  type: 'skills_enable';
  name: string;
}

export interface SkillsDisableRequest {
  type: 'skills_disable';
  name: string;
}

export interface SkillsConfigureRequest {
  type: 'skills_configure';
  name: string;
  env?: Record<string, string>;
  apiKey?: string;
  config?: Record<string, unknown>;
}

export interface SkillsInstallRequest {
  type: 'skills_install';
  slug: string;
  version?: string;
}

export interface SkillsUninstallRequest {
  type: 'skills_uninstall';
  name: string;
}

export interface SkillsUpdateRequest {
  type: 'skills_update';
  name: string;
}

export interface SkillsCheckUpdatesRequest {
  type: 'skills_check_updates';
}

export interface SkillsSearchRequest {
  type: 'skills_search';
  query: string;
}

export interface SkillsInspectRequest {
  type: 'skills_inspect';
  slug: string;
}

// === Server → Client ===

export interface SkillsListResponse {
  type: 'skills_list_response';
  skills: Array<{
    id: string;
    name: string;
    description: string;
    emoji?: string;
    homepage?: string;
    source: 'bundled' | 'managed' | 'workspace' | 'clawhub' | 'extra';
    state: 'enabled' | 'disabled' | 'available';
    degraded: boolean;
    missingRequirements?: { bins?: string[]; env?: string[]; permissions?: string[] };
    installedVersion?: string;
    latestVersion?: string;
    updateAvailable: boolean;
    userInvocable: boolean;
    clawhub?: { author: string; stars: number; installs: number; reports: number; publishedAt: string };
  }>;
}

export interface SkillStateChanged {
  type: 'skills_state_changed';
  name: string;
  state: 'enabled' | 'disabled' | 'installed' | 'uninstalled';
}

export interface SkillsOperationResponse {
  type: 'skills_operation_response';
  operation: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface SkillDetailResponse {
  type: 'skill_detail_response';
  skillId: string;
  body: string;
  icon?: string;
  error?: string;
}

export interface SkillsInspectResponse {
  type: 'skills_inspect_response';
  slug: string;
  data?: {
    skill: { slug: string; displayName: string; summary: string };
    owner?: { handle: string; displayName: string; image?: string } | null;
    stats?: { stars: number; installs: number; downloads: number; versions: number } | null;
    createdAt?: number | null;
    updatedAt?: number | null;
    latestVersion?: { version: string; changelog?: string } | null;
    files?: Array<{ path: string; size: number; contentType?: string }> | null;
    skillMdContent?: string | null;
  };
  error?: string;
}
