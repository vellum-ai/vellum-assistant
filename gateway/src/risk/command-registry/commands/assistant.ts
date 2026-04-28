import type {
  ArgRule,
  CommandRiskSpec,
  RegistryRisk,
} from "../../risk-types.js";

/**
 * Assistant CLI command paths derived from assistant/src/cli/commands.
 *
 * Includes feature-gated command groups (domain/email) so risk coverage
 * stays complete even when those commands are not currently registered by
 * buildCliProgram() in the local environment.
 */
const ASSISTANT_SUPPORTED_COMMAND_PATHS = [
  "attachment",
  "attachment register",
  "attachment lookup",
  "audit",
  "auth",
  "auth info",
  "autonomy",
  "autonomy get",
  "autonomy set",
  "avatar",
  "avatar generate",
  "avatar set",
  "avatar remove",
  "avatar get",
  "avatar character",
  "avatar character update",
  "avatar character components",
  "avatar character ascii",
  "backup",
  "backup enable",
  "backup disable",
  "backup destinations",
  "backup destinations list",
  "backup destinations add",
  "backup destinations remove",
  "backup destinations set-encrypt",
  "backup status",
  "backup list",
  "backup create",
  "backup restore",
  "backup verify",
  "bash",
  "browser",
  "browser navigate",
  "browser snapshot",
  "browser screenshot",
  "browser close",
  "browser attach",
  "browser detach",
  "browser click",
  "browser type",
  "browser press-key",
  "browser scroll",
  "browser select-option",
  "browser hover",
  "browser wait-for",
  "browser extract",
  "browser wait-for-download",
  "browser fill-credential",
  "browser status",
  "cache",
  "cache set",
  "cache get",
  "cache delete",
  "channel-verification-sessions",
  "channel-verification-sessions create",
  "channel-verification-sessions status",
  "channel-verification-sessions resend",
  "channel-verification-sessions cancel",
  "channel-verification-sessions revoke",
  "clients",
  "clients list",
  "completions",
  "config",
  "config set",
  "config get",
  "config schema",
  "config list",
  "config validate-allowlist",
  "contacts",
  "contacts list",
  "contacts get",
  "contacts merge",
  "contacts upsert",
  "contacts channels",
  "contacts channels update-status",
  "contacts invites",
  "contacts invites list",
  "contacts invites create",
  "contacts invites revoke",
  "contacts invites redeem",
  "conversations",
  "conversations import",
  "conversations defer",
  "conversations defer list",
  "conversations defer cancel",
  "conversations list",
  "conversations new",
  "conversations rename",
  "conversations export",
  "conversations clear",
  "conversations wipe",
  "conversations wake",
  "credential-execution",
  "credential-execution grants",
  "credential-execution grants list",
  "credential-execution grants revoke",
  "credential-execution audit",
  "credential-execution audit list",
  "credentials",
  "credentials list",
  "credentials prompt",
  "credentials set",
  "credentials delete",
  "credentials inspect",
  "credentials reveal",
  "image-generation",
  "image-generation generate",
  "inference",
  "inference send",
  "llm",
  "llm send",
  "keys",
  "keys list",
  "keys set",
  "keys delete",
  "mcp",
  "mcp list",
  "mcp reload",
  "mcp add",
  "mcp auth",
  "mcp remove",
  "memory",
  "memory status",
  "memory backfill",
  "memory cleanup-segments",
  "memory query",
  "memory rebuild-index",
  "memory re-extract",
  "memory compact",
  "memory v2",
  "memory v2 migrate",
  "memory v2 rebuild-edges",
  "memory v2 reembed",
  "memory v2 activation",
  "memory v2 validate",
  "notifications",
  "notifications send",
  "notifications list",
  "oauth",
  "oauth providers",
  "oauth providers list",
  "oauth providers get",
  "oauth providers register",
  "oauth providers update",
  "oauth providers delete",
  "oauth mode",
  "oauth apps",
  "oauth apps list",
  "oauth apps get",
  "oauth apps upsert",
  "oauth apps delete",
  "oauth connect",
  "oauth status",
  "oauth ping",
  "oauth request",
  "oauth disconnect",
  "oauth token",
  "platform",
  "platform connect",
  "platform status",
  "platform disconnect",
  "platform callback-routes",
  "platform callback-routes register",
  "platform callback-routes list",
  "routes",
  "routes list",
  "routes inspect",
  "sequence",
  "sequence list",
  "sequence get",
  "sequence pause",
  "sequence resume",
  "sequence cancel-enrollment",
  "sequence stats",
  "sequence guardrails",
  "sequence guardrails show",
  "sequence guardrails set",
  "skills",
  "skills inspect",
  "skills list",
  "skills search",
  "skills install",
  "skills uninstall",
  "skills add",
  "stt",
  "stt transcribe",
  "task",
  "task save",
  "task list",
  "task run",
  "task delete",
  "task queue",
  "task queue show",
  "task queue add",
  "task queue update",
  "task queue remove",
  "task queue run",
  "trust",
  "trust list",
  "trust add",
  "trust update",
  "trust remove",
  "tts",
  "tts synthesize",
  "ui",
  "ui request",
  "ui confirm",
  "usage",
  "usage totals",
  "usage daily",
  "usage breakdown",
  "watchers",
  "watchers list",
  "watchers create",
  "watchers update",
  "watchers delete",
  "watchers digest",
  "webhooks",
  "webhooks register",
  "webhooks list",
  // Feature-gated command groups
  "domain",
  "domain register",
  "domain status",
  "email",
  "email register",
  "email unregister",
  "email status",
  "email list",
  "email download",
  "email send",
  "email attachment",
] as const;

interface AssistantRiskOverride {
  path: string;
  risk: RegistryRisk;
  reason?: string;
}

function ensurePath(root: CommandRiskSpec, path: string): CommandRiskSpec {
  const segments = path
    .trim()
    .split(/\s+/)
    .filter((segment) => segment.length > 0);

  let current = root;
  for (const segment of segments) {
    current.subcommands ??= {};
    current.subcommands[segment] ??= { baseRisk: "low" };
    current = current.subcommands[segment];
  }

  return current;
}

function getExistingPath(root: CommandRiskSpec, path: string): CommandRiskSpec {
  const segments = path
    .trim()
    .split(/\s+/)
    .filter((segment) => segment.length > 0);

  let current = root;
  for (const segment of segments) {
    const next = current.subcommands?.[segment];
    if (!next) {
      throw new Error(`Assistant risk spec path is missing: ${path}`);
    }
    current = next;
  }

  return current;
}

const spec: CommandRiskSpec = {
  baseRisk: "low",
  subcommands: {},
};

for (const path of ASSISTANT_SUPPORTED_COMMAND_PATHS) {
  ensurePath(spec, path);
}

// Explicitly preserve `assistant help` as a low-risk pseudo-subcommand.
ensurePath(spec, "help");

const riskOverrides: AssistantRiskOverride[] = [
  // Sensitive credential/token operations
  {
    path: "oauth token",
    risk: "high",
    reason: "Exposes OAuth access token",
  },
  {
    path: "credentials prompt",
    risk: "low",
    reason: "Prompts user for credential via secure UI — user has full control",
  },
  {
    path: "credentials reveal",
    risk: "high",
    reason: "Reveals stored credential value",
  },
  {
    path: "credentials set",
    risk: "high",
    reason: "Stores or updates credential value",
  },
  {
    path: "credentials delete",
    risk: "high",
    reason: "Deletes stored credential value",
  },
  {
    path: "keys set",
    risk: "high",
    reason: "Stores API key material",
  },
  {
    path: "keys delete",
    risk: "high",
    reason: "Deletes API key material",
  },
  {
    path: "trust add",
    risk: "high",
    reason: "Creates trust rule that affects auto-approve behavior",
  },
  {
    path: "trust update",
    risk: "high",
    reason: "Modifies trust rule risk level or description",
  },
  {
    path: "trust remove",
    risk: "high",
    reason: "Removes trust rule",
  },

  // Destructive assistant-state operations
  {
    path: "backup restore",
    risk: "high",
    reason: "Restores backup and overwrites workspace state",
  },
  {
    path: "conversations clear",
    risk: "medium",
    reason: "Deletes conversation history",
  },
  {
    path: "conversations wipe",
    risk: "high",
    reason: "Deletes specific conversation data",
  },

  // Mutating assistant state / external side effects
  { path: "attachment register", risk: "medium" },
  { path: "autonomy set", risk: "medium" },
  { path: "avatar generate", risk: "low" },
  { path: "avatar set", risk: "low" },
  { path: "avatar remove", risk: "low" },
  { path: "avatar character update", risk: "low" },
  { path: "backup enable", risk: "low" },
  { path: "backup disable", risk: "high" },
  { path: "backup destinations add", risk: "high" },
  { path: "backup destinations remove", risk: "high" },
  { path: "backup destinations set-encrypt", risk: "high" },
  { path: "backup create", risk: "low" },
  { path: "cache set", risk: "low" },
  { path: "cache delete", risk: "low" },
  { path: "channel-verification-sessions create", risk: "high" },
  { path: "channel-verification-sessions resend", risk: "high" },
  { path: "channel-verification-sessions cancel", risk: "low" },
  { path: "channel-verification-sessions revoke", risk: "low" },
  { path: "config set", risk: "low" },
  { path: "contacts merge", risk: "medium" },
  { path: "contacts upsert", risk: "medium" },
  { path: "contacts channels update-status", risk: "medium" },
  { path: "contacts invites create", risk: "high" },
  { path: "contacts invites revoke", risk: "medium" },
  { path: "contacts invites redeem", risk: "high" },
  { path: "conversations import", risk: "high" },
  { path: "conversations defer", risk: "low" },
  { path: "conversations defer cancel", risk: "low" },
  { path: "conversations new", risk: "low" },
  { path: "conversations rename", risk: "low" },
  { path: "conversations wake", risk: "low" },
  { path: "credential-execution grants revoke", risk: "medium" },
  { path: "domain register", risk: "medium" },
  { path: "email register", risk: "medium" },
  { path: "email unregister", risk: "medium" },
  { path: "email send", risk: "high" },
  { path: "image-generation generate", risk: "medium" },
  { path: "inference send", risk: "medium" },
  { path: "llm send", risk: "medium" },
  { path: "mcp reload", risk: "low" },
  { path: "mcp add", risk: "high" },
  { path: "mcp auth", risk: "medium" },
  { path: "mcp remove", risk: "low" },
  { path: "memory backfill", risk: "low" },
  { path: "memory cleanup-segments", risk: "low" },
  { path: "memory rebuild-index", risk: "low" },
  { path: "memory re-extract", risk: "low" },
  { path: "memory compact", risk: "low" },
  { path: "memory v2 migrate", risk: "low" },
  { path: "memory v2 rebuild-edges", risk: "low" },
  { path: "memory v2 reembed", risk: "low" },
  { path: "memory v2 activation", risk: "low" },
  { path: "notifications send", risk: "low" },
  {
    path: "oauth request",
    risk: "medium",
    reason: "Makes authenticated OAuth request",
  },
  {
    path: "oauth connect",
    risk: "low",
    reason: "Creates OAuth connection",
  },
  {
    path: "oauth disconnect",
    risk: "medium",
    reason: "Removes OAuth connection",
  },
  { path: "oauth providers register", risk: "medium" },
  { path: "oauth providers update", risk: "medium" },
  { path: "oauth providers delete", risk: "medium" },
  { path: "oauth apps delete", risk: "medium" },
  { path: "platform connect", risk: "low" },
  { path: "platform disconnect", risk: "medium" },
  { path: "platform callback-routes register", risk: "low" },
  { path: "sequence pause", risk: "medium" },
  { path: "sequence resume", risk: "medium" },
  { path: "sequence cancel-enrollment", risk: "medium" },
  { path: "sequence guardrails set", risk: "medium" },
  { path: "skills install", risk: "high" },
  { path: "skills uninstall", risk: "medium" },
  { path: "skills add", risk: "high" },
  { path: "stt transcribe", risk: "medium" },
  { path: "task save", risk: "medium" },
  { path: "task run", risk: "medium" },
  { path: "task delete", risk: "medium" },
  { path: "task queue add", risk: "medium" },
  { path: "task queue update", risk: "medium" },
  { path: "task queue remove", risk: "medium" },
  { path: "task queue run", risk: "medium" },
  { path: "tts synthesize", risk: "medium" },
  { path: "watchers create", risk: "medium" },
  { path: "watchers update", risk: "medium" },
  { path: "watchers delete", risk: "medium" },
  { path: "webhooks register", risk: "high" },

  // Browser automation commands (mutating external browser/page state)
  { path: "browser navigate", risk: "medium" },
  { path: "browser close", risk: "medium" },
  { path: "browser attach", risk: "medium" },
  { path: "browser detach", risk: "low" },
  { path: "browser click", risk: "medium" },
  { path: "browser type", risk: "medium" },
  { path: "browser press-key", risk: "medium" },
  { path: "browser scroll", risk: "low" },
  { path: "browser select-option", risk: "medium" },
  { path: "browser hover", risk: "low" },
  { path: "browser wait-for", risk: "low" },
  { path: "browser wait-for-download", risk: "medium" },
  { path: "browser fill-credential", risk: "high" },
];

for (const override of riskOverrides) {
  const node = getExistingPath(spec, override.path);
  node.baseRisk = override.risk;
  if (override.reason) {
    node.reason = override.reason;
  }
}

const oauthModeArgRules: ArgRule[] = [
  {
    id: "assistant-oauth-mode:set",
    flags: ["--set"],
    risk: "high",
    reason: "Changes OAuth mode",
  },
];
getExistingPath(spec, "oauth mode").argRules = oauthModeArgRules;

const assistantBashArgRules: ArgRule[] = [
  {
    id: "assistant-bash:command",
    valuePattern: String.raw`^(?!bash$|--help$|-h$).+`,
    risk: "high",
    reason: "Executes arbitrary shell command",
  },
];
getExistingPath(spec, "bash").argRules = assistantBashArgRules;

export default spec;
