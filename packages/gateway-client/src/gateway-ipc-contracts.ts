/**
 * Shared IPC contracts for assistant-to-gateway gateway-owned reads.
 */

import { CHANNEL_IDS } from "@vellumai/service-contracts/channels";
import { z } from "zod";

export const GATEWAY_LOG_LEVEL_NAMES = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;
export type GatewayLogLevelName = (typeof GATEWAY_LOG_LEVEL_NAMES)[number];

const GatewayLogsTailIpcParamsShape = {
  n: z.number().int().min(1).max(1000).optional(),
  level: z.enum(GATEWAY_LOG_LEVEL_NAMES).optional(),
  module: z.string().optional(),
};

export const GatewayLogsTailIpcParamsSchema = z
  .object(GatewayLogsTailIpcParamsShape)
  .strict()
  .default({});

export type GatewayLogsTailIpcParams = z.infer<
  typeof GatewayLogsTailIpcParamsSchema
>;

export const GatewayLogsTailRouteParamsSchema = z
  .object({
    ...GatewayLogsTailIpcParamsShape,
    n: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict();

export type GatewayLogsTailRouteParams = z.infer<
  typeof GatewayLogsTailRouteParamsSchema
>;

export const GatewayLogsTailIpcResponseSchema = z.object({
  lines: z.array(z.record(z.string(), z.unknown())),
  truncated: z.boolean(),
});

export type GatewayLogsTailIpcResponse = z.infer<
  typeof GatewayLogsTailIpcResponseSchema
>;

export const TrustRulesListIpcParamsSchema = z
  .object({
    origin: z.string().optional(),
    tool: z.string().optional(),
    include_all: z.boolean().optional(),
    include_deleted: z.boolean().optional(),
  })
  .strict()
  .default({});

export type TrustRulesListIpcParams = z.infer<
  typeof TrustRulesListIpcParamsSchema
>;

/** The three risk levels a trust rule can set and a registry default can carry. */
export const RISK_LEVEL_VALUES = ["low", "medium", "high"] as const;
export type RiskLevelValue = (typeof RISK_LEVEL_VALUES)[number];
export const RiskLevelValueSchema = z.enum(RISK_LEVEL_VALUES);

export const TrustRuleSchema = z.object({
  id: z.string(),
  tool: z.string(),
  pattern: z.string(),
  risk: RiskLevelValueSchema,
  description: z.string(),
  origin: z.enum(["default", "user_defined"]),
  userModified: z.boolean(),
  deleted: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TrustRule = z.infer<typeof TrustRuleSchema>;

export const TrustRulesListIpcResponseSchema = z.object({
  rules: z.array(TrustRuleSchema),
});

export type TrustRulesListIpcResponse = z.infer<
  typeof TrustRulesListIpcResponseSchema
>;

export const UpdateContactChannelIpcParamsSchema = z.object({
  contactChannelId: z.string().min(1),
  status: z.string().optional(),
  policy: z.string().optional(),
  reason: z.string().optional(),
});

export type UpdateContactChannelIpcParams = z.infer<
  typeof UpdateContactChannelIpcParamsSchema
>;

export const UpdateContactChannelIpcResponseSchema = z.object({
  ok: z.boolean(),
  // The gateway-native handler owns the full contact payload shape; pass it
  // through verbatim rather than re-declaring channel fields here.
  contact: z.object({}).passthrough().optional(),
});

export type UpdateContactChannelIpcResponse = z.infer<
  typeof UpdateContactChannelIpcResponseSchema
>;

export const MergeContactsIpcParamsSchema = z.object({
  keepId: z.string().min(1),
  mergeId: z.string().min(1),
});

export type MergeContactsIpcParams = z.infer<
  typeof MergeContactsIpcParamsSchema
>;

export const MergeContactsIpcResponseSchema = z.object({
  ok: z.literal(true),
  // The gateway-native handler owns the full contact payload shape; pass it
  // through verbatim rather than re-declaring channel fields here.
  contact: z.object({}).passthrough().optional(),
});

export type MergeContactsIpcResponse = z.infer<
  typeof MergeContactsIpcResponseSchema
>;

export const MarkChannelVerifiedIpcParamsSchema = z.object({
  contactChannelId: z.string().min(1),
  // Audit source for the verification. CLI/session-driven verifications
  // pass "challenge"; manual guardian attest uses "manual" (HTTP path).
  verifiedVia: z.enum(["challenge", "manual"]).default("challenge"),
});

export type MarkChannelVerifiedIpcParams = z.infer<
  typeof MarkChannelVerifiedIpcParamsSchema
>;

export const MarkChannelVerifiedIpcResponseSchema = z.object({
  ok: z.boolean(),
  didWrite: z.boolean(),
  channel: z.object({
    id: z.string(),
    contactId: z.string(),
    type: z.string(),
    address: z.string(),
    status: z.string(),
    verifiedAt: z.number().nullable(),
    verifiedVia: z.string().nullable(),
  }),
});

export type MarkChannelVerifiedIpcResponse = z.infer<
  typeof MarkChannelVerifiedIpcResponseSchema
>;

export const UpsertVerifiedChannelIpcParamsSchema = z.object({
  type: z.string().min(1),
  address: z.string().min(1),
  externalChatId: z.string().min(1),
  displayName: z.string().optional(),
  username: z.string().optional(),
  // Audit source for the verification. Free text (DB column is text) so the
  // invite-activation path can pass "invite"; do not narrow to an enum.
  verifiedVia: z.string().optional(),
  // Target contact to bind the channel to (invite redemption). When set, an
  // existing channel for the same (type,address) under a different contact is
  // reassigned to this contact, mirroring the assistant's
  // reassignConflictingChannels.
  contactId: z.string().min(1).optional(),
  // Relax the revoked refusal guard so a valid invite can reactivate a revoked
  // member. Blocked actors are refused regardless.
  allowRevokedReactivation: z.boolean().optional(),
});

export type UpsertVerifiedChannelIpcParams = z.infer<
  typeof UpsertVerifiedChannelIpcParamsSchema
>;

export const UpsertVerifiedChannelIpcResponseSchema = z.object({
  ok: z.boolean(),
  verified: z.boolean(),
  // Present only when verified — a blocked/revoked skip omits the channel.
  channel: z
    .object({
      id: z.string(),
      contactId: z.string(),
      type: z.string(),
      address: z.string(),
      status: z.string(),
      verifiedAt: z.number().nullable(),
      verifiedVia: z.string().nullable(),
    })
    .optional(),
});

export type UpsertVerifiedChannelIpcResponse = z.infer<
  typeof UpsertVerifiedChannelIpcResponseSchema
>;

export const CreateContactIpcResponseSchema = z.object({
  contactId: z.string(),
  // Gateway channel id for the (channelType, address) pair, resolved from the
  // gateway DB (source of truth). Empty when the read-back found no row.
  channelId: z.string(),
});

export type CreateContactIpcResponse = z.infer<
  typeof CreateContactIpcResponseSchema
>;

export const MarkChannelRevokedIpcParamsSchema = z.object({
  contactChannelId: z.string().min(1),
  // Audit reason for the downgrade. The verification-revoke flow passes
  // "guardian_binding_revoked", the only reason allowed to downgrade a
  // guardian channel (guardian guard, invariant 4).
  reason: z.string().optional(),
});

export type MarkChannelRevokedIpcParams = z.infer<
  typeof MarkChannelRevokedIpcParamsSchema
>;

export const MarkChannelRevokedIpcResponseSchema = z.object({
  ok: z.boolean(),
  didWrite: z.boolean(),
  channel: z.object({
    id: z.string(),
    contactId: z.string(),
    type: z.string(),
    address: z.string(),
    status: z.string(),
    revokedReason: z.string().nullable(),
  }),
});

export type MarkChannelRevokedIpcResponse = z.infer<
  typeof MarkChannelRevokedIpcResponseSchema
>;

export const ContactReadChannelSchema = z.object({
  id: z.string(),
  contactId: z.string(),
  type: z.string(),
  address: z.string(),
  isPrimary: z.boolean(),
  externalUserId: z.string().nullable(),
  status: z.string(),
  policy: z.string(),
  verifiedAt: z.number().nullable(),
  verifiedVia: z.string().nullable(),
  lastSeenAt: z.number().nullable(),
  interactionCount: z.number().nullable(),
  lastInteraction: z.number().nullable(),
  revokedReason: z.string().nullable(),
  blockedReason: z.string().nullable(),
});

export type ContactReadChannel = z.infer<typeof ContactReadChannelSchema>;

export const ContactReadSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  role: z.string(),
  notes: z.string().nullable().optional(),
  contactType: z.string().nullable().optional(),
  lastInteraction: z.number().nullable().optional(),
  interactionCount: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  channels: z.array(ContactReadChannelSchema),
});

export type ContactRead = z.infer<typeof ContactReadSchema>;

export const AssistantContactMetadataSchema = z.object({
  contactId: z.string(),
  species: z.string(),
  metadata: z.object({}).passthrough().nullable(),
});

export type AssistantContactMetadata = z.infer<
  typeof AssistantContactMetadataSchema
>;

export const ListContactsIpcParamsSchema = z
  .object({
    limit: z.number().optional(),
    role: z.string().optional(),
    // Restrict the read to these contact ids (any order). Used by the daemon to
    // batch-hydrate gateway-owned telemetry onto daemon-native filtered/search
    // results without re-implementing search in the gateway. When present,
    // `role`/`limit` filtering is bypassed — the id set is the filter.
    ids: z.array(z.string()).optional(),
  })
  .strict()
  .default({});

export type ListContactsIpcParams = z.infer<typeof ListContactsIpcParamsSchema>;

export const ListContactsIpcResponseSchema = z.object({
  ok: z.boolean(),
  contacts: z.array(ContactReadSchema),
});

export type ListContactsIpcResponse = z.infer<
  typeof ListContactsIpcResponseSchema
>;

export const GetContactIpcParamsSchema = z
  .object({ contactId: z.string() })
  .strict();

export type GetContactIpcParams = z.infer<typeof GetContactIpcParamsSchema>;

export const GetContactIpcResponseSchema = z.object({
  ok: z.boolean(),
  contact: ContactReadSchema,
  assistantMetadata: AssistantContactMetadataSchema.optional(),
});

export type GetContactIpcResponse = z.infer<typeof GetContactIpcResponseSchema>;

export const GetGuardianContactIpcParamsSchema = z
  .object({})
  .strict()
  .default({});

export type GetGuardianContactIpcParams = z.infer<
  typeof GetGuardianContactIpcParamsSchema
>;

export const GetGuardianContactIpcResponseSchema = z.object({
  ok: z.boolean(),
  guardianIds: z.array(z.string()),
});

export type GetGuardianContactIpcResponse = z.infer<
  typeof GetGuardianContactIpcResponseSchema
>;

// ── classify_risk ────────────────────────────────────────────────────────────
// Risk classification is gateway-owned; the assistant sends one request per
// tool invocation and reads the whole answer back. The gateway validates the
// request against `ClassifyRiskIpcParamsSchema`; the assistant validates the
// response against `ClassifyRiskIpcResponseSchema` and fails closed on a
// mismatch.

/** A classified risk; `unknown` is the classifier's own "not in registry". */
export const ClassifiedRiskSchema = z.enum([...RISK_LEVEL_VALUES, "unknown"]);
export type ClassifiedRisk = z.infer<typeof ClassifiedRiskSchema>;

/** How a risk was determined: a user trust rule, the registry, or neither. */
export const RiskMatchTypeSchema = z.enum(["user_rule", "registry", "unknown"]);
export type RiskMatchType = z.infer<typeof RiskMatchTypeSchema>;

/**
 * File classifier context the assistant pre-resolves (it owns the workspace
 * filesystem) so the gateway can classify file tools without assistant path
 * helpers. Directories are canonicalized (symlinks resolved) by the sender.
 */
export const ClassifyRiskFileContextSchema = z.object({
  protectedDir: z.string(),
  deprecatedDir: z.string(),
  hooksDir: z.string(),
  pluginsDir: z.string().optional(),
  toolsDir: z.string().optional(),
  routesDir: z.string().optional(),
  workflowsDir: z.string().optional(),
  /** Monitoring data dir: the sentinel lives here, writes are code-injection risk. */
  monitoringDir: z.string().optional(),
  actorTokenSigningKeyPath: z.string(),
  skillSourceDirs: z.array(z.string()),
});
export type ClassifyRiskFileContext = z.infer<
  typeof ClassifyRiskFileContextSchema
>;

/** Skill metadata the assistant pre-resolves for skill-load classification. */
export const ClassifyRiskSkillMetadataSchema = z.object({
  skillId: z.string(),
  selector: z.string(),
  versionHash: z.string(),
  transitiveHash: z.string().optional(),
  hasInlineExpansions: z.boolean(),
  isDynamic: z.boolean(),
});
export type ClassifyRiskSkillMetadata = z.infer<
  typeof ClassifyRiskSkillMetadataSchema
>;

export const ClassifyRiskIpcParamsSchema = z.object({
  tool: z.string().min(1),
  command: z.string().optional(),
  url: z.string().optional(),
  path: z.string().optional(),
  /**
   * The file tool's target path with symlinks resolved by the assistant. The
   * gateway's security escalation prefix checks use it so a symlink cannot
   * mask a write into a protected directory; falls back to lexical resolution
   * of `path` when absent.
   */
  resolvedPath: z.string().optional(),
  /**
   * The sandbox file tool's working directory with symlinks resolved. Paired
   * with `resolvedPath` for the workspace-boundary check so a symlinked
   * workspace prefix (macOS `/var` → `/private/var`) does not read as an
   * escape. Absent for host tools.
   */
  resolvedWorkingDir: z.string().optional(),
  skill: z.string().optional(),
  mode: z.string().optional(),
  script: z.string().optional(),
  workingDir: z.string().optional(),
  allowPrivateNetwork: z.boolean().optional(),
  networkMode: z.string().optional(),
  isContainerized: z.boolean().optional(),
  workspaceRoot: z.string().optional(),
  fileContext: ClassifyRiskFileContextSchema.optional(),
  skillMetadata: ClassifyRiskSkillMetadataSchema.optional(),
  /**
   * The tool's registry default risk, for tools with no dedicated classifier.
   * The gateway answers with it (`matchType: "registry"`); absent, the tool is
   * unknown and answers `medium`.
   */
  registryDefaultRisk: RiskLevelValueSchema.optional(),
  /** Number of credential references attached to this tool invocation. */
  credentialRefCount: z.number().int().nonnegative().optional(),
  /**
   * For `host_file_transfer` to_sandbox: the workspace-side destination path
   * and the sandbox working directory it resolves against, so a transfer that
   * lands an executable file in a code-injection sink (tools, routes, hooks,
   * plugins, skills) escalates even though `path` carries the host-side source.
   */
  transferSandboxDestPath: z.string().optional(),
  transferSandboxWorkingDir: z.string().optional(),
  /** `transferSandboxDestPath` with symlinks resolved by the assistant. */
  resolvedTransferDestPath: z.string().optional(),
});
export type ClassifyRiskIpcParams = z.infer<typeof ClassifyRiskIpcParamsSchema>;

/** Regex ladder shown when the user saves a classification (display only). */
export const RiskPatternScopeOptionSchema = z.object({
  pattern: z.string(),
  label: z.string(),
});
export type RiskPatternScopeOption = z.infer<
  typeof RiskPatternScopeOptionSchema
>;

/** Minimatch ladder for the "always allow" prompt option (what a rule matches). */
export const RiskAllowlistOptionSchema = z.object({
  label: z.string(),
  description: z.string(),
  pattern: z.string(),
});
export type RiskAllowlistOption = z.infer<typeof RiskAllowlistOptionSchema>;

/** Directory ladder for filesystem operations; `scope` is a path glob or `everywhere`. */
export const RiskDirectoryScopeOptionSchema = z.object({
  scope: z.string(),
  label: z.string(),
});
export type RiskDirectoryScopeOption = z.infer<
  typeof RiskDirectoryScopeOptionSchema
>;

export const RiskDangerousPatternSchema = z.object({
  type: z.string(),
  description: z.string(),
  text: z.string(),
});
export type RiskDangerousPattern = z.infer<typeof RiskDangerousPatternSchema>;

export const ClassifyRiskIpcResponseSchema = z.object({
  risk: ClassifiedRiskSchema,
  reason: z.string(),
  matchType: RiskMatchTypeSchema,
  scopeOptions: z.array(RiskPatternScopeOptionSchema),
  allowlistOptions: z.array(RiskAllowlistOptionSchema).optional(),
  actionKeys: z.array(z.string()).optional(),
  commandCandidates: z.array(z.string()).optional(),
  dangerousPatterns: z.array(RiskDangerousPatternSchema).optional(),
  opaqueConstructs: z.boolean().optional(),
  isComplexSyntax: z.boolean().optional(),
  sandboxAutoApprove: z.boolean().optional(),
  /**
   * Lexically-resolved path arguments from sandbox-auto-approve-eligible bash
   * segments. The gateway has no filesystem access; the assistant resolves
   * these through symlinks and revokes `sandboxAutoApprove` if any escapes
   * the workspace.
   */
  sandboxPathArgs: z.array(z.string()).optional(),
  directoryScopeOptions: z.array(RiskDirectoryScopeOptionSchema).optional(),
  /** Fully resolved filesystem path arguments, for directory-scoped rule matching. */
  resolvedPaths: z.array(z.string()).optional(),
});
export type ClassifyRiskIpcResponse = z.infer<
  typeof ClassifyRiskIpcResponseSchema
>;

// ── Channel socket health ────────────────────────────────────────────────────

/**
 * Whether a channel that holds a long-lived inbound socket is currently
 * receiving.
 *
 * Only channels whose ingress is a socket the gateway owns can answer this.
 * Webhook channels answer the same question from the daemon side by checking
 * their registration instead, so they report `unsupported` here rather than a
 * misleading `disconnected`.
 */
export const CHANNEL_SOCKET_HEALTH_STATUSES = [
  /** A live connection the liveness watchdog is vouching for. */
  "connected",
  /** The channel is configured and running, but holds no live connection. */
  "disconnected",
  /** No client exists, because the channel's credentials are not configured. */
  "not_configured",
  /** This channel's ingress is not a gateway-owned socket. */
  "unsupported",
] as const;

export const ChannelSocketHealthIpcParamsSchema = z.object({
  channel: z.enum(CHANNEL_IDS),
});

export type ChannelSocketHealthIpcParams = z.infer<
  typeof ChannelSocketHealthIpcParamsSchema
>;

export const ChannelSocketHealthIpcResponseSchema = z.object({
  channel: z.enum(CHANNEL_IDS),
  status: z.enum(CHANNEL_SOCKET_HEALTH_STATUSES),
  /**
   * Epoch millis when the transport last proved it was alive, by whatever
   * means that transport proves it: a pong on Slack, an op 11 ACK on Discord.
   *
   * Absent means "not proven yet", never "proven dead". A connection's first
   * proof is one full interval after it opens, so a healthy reconnect reports
   * `connected` with no timestamp. Corroborating evidence, not a verdict.
   */
  lastLivenessAt: z.number().optional(),
});

export type ChannelSocketHealthIpcResponse = z.infer<
  typeof ChannelSocketHealthIpcResponseSchema
>;
