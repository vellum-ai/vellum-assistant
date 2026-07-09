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
  "changelog",
  "changelog list",
  "changelog show",
  "channel-verification-sessions",
  "channel-verification-sessions create",
  "channel-verification-sessions status",
  "channel-verification-sessions resend",
  "channel-verification-sessions cancel",
  "channel-verification-sessions revoke",
  "channels",
  "channels list",
  "channels get",
  "clients",
  "clients disconnect",
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
  "contacts prompt",
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
  "conversations wake",
  "credential-execution",
  "credential-execution grants",
  "credential-execution grants list",
  "pending",
  "pending list",
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
  "credentials status",
  "db",
  "db status",
  "db repair",
  "gateway",
  "gateway logs",
  "gateway logs tail",
  "image-generation",
  "image-generation generate",
  "inference",
  "inference providers",
  "inference providers connections",
  "inference providers connections create",
  "inference providers connections delete",
  "inference providers connections get",
  "inference providers connections list",
  "inference providers connections update",
  "inference send",
  "inference session",
  "inference session open",
  "inference session close",
  "inference session list",
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
  "memory items",
  "memory items list",
  "memory items get",
  "memory items create",
  "memory items update",
  "memory items delete",
  "memory v2",
  "memory v2 reembed",
  "memory v2 reembed-skills",
  "memory v2 activation",
  "memory v2 validate",
  "memory v3",
  "memory v3 rebuild-index",
  "memory v3 backfill-sections",
  "memory v3 eval",
  "memory retrospective",
  "memory retrospective run",
  "memory worker",
  "memory worker start",
  "memory worker stop",
  "memory worker status",
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
  "platform credits",
  "platform disconnect",
  "platform callback-routes",
  "platform callback-routes register",
  "platform callback-routes list",
  "monitoring",
  "monitoring start",
  "monitoring stop",
  "monitoring status",
  "ps",
  "routes",
  "routes list",
  "routes inspect",
  "schedules",
  "schedules list",
  "schedules get",
  "schedules inspect",
  "schedules runs",
  "schedules create",
  "schedules update",
  "schedules enable",
  "schedules disable",
  "schedules cancel",
  "schedules delete",
  "schedules execute",
  "schedules worker",
  "schedules worker start",
  "schedules worker stop",
  "schedules worker status",
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
  "status",
  "stt",
  "stt transcribe",
  "telemetry",
  "telemetry flush",
  "tools",
  "tools list",
  "tools run",
  "trust",
  "trust list",
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
  "plugins",
  "plugins diff",
  "plugins install",
  "plugins inspect",
  "plugins list",
  "plugins search",
  "plugins uninstall",
  "plugins upgrade",
  "plugins enable",
  "plugins disable",
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

  // Mutating assistant state / external side effects
  { path: "attachment register", risk: "medium" },
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
  {
    path: "config set",
    risk: "medium",
    reason: "Writes a value into the assistant's runtime configuration",
  },
  { path: "contacts prompt", risk: "medium" },
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
  {
    path: "db repair",
    risk: "medium",
    reason:
      "Runs the database repair sequence. First step is a read-only integrity check; future steps will mutate the SQLite database to recover state.",
  },
  { path: "domain register", risk: "medium" },
  { path: "email register", risk: "medium" },
  { path: "email unregister", risk: "medium" },
  { path: "email send", risk: "high" },
  { path: "image-generation generate", risk: "medium" },
  { path: "inference send", risk: "medium" },
  {
    path: "inference providers connections list",
    risk: "low",
    reason: "Read-only listing of provider_connection rows",
  },
  {
    path: "inference providers connections get",
    risk: "low",
    reason: "Read-only fetch of a single provider_connection row",
  },
  {
    path: "inference providers connections create",
    risk: "medium",
    reason:
      "Inserts a provider_connection row referenced by inference profiles",
  },
  {
    path: "inference providers connections update",
    risk: "medium",
    reason: "Mutates provider_connection auth config in place",
  },
  {
    path: "inference providers connections delete",
    risk: "medium",
    reason:
      "Deletes a provider_connection row; refuses unless --force when profiles still reference it",
  },
  { path: "llm send", risk: "medium" },
  {
    path: "tools run",
    risk: "medium",
    reason:
      "Executes a registered tool directly. Runs non-interactive and non-guardian, so prompt-gated tools auto-deny, but it still invokes a tool outside the agent loop.",
  },
  {
    path: "inference session open",
    risk: "low",
    reason:
      "Opens a reversible conversation-scoped profile session; server validates the profile name",
  },
  {
    path: "inference session close",
    risk: "low",
    reason: "Closes an active profile session; idempotent",
  },
  {
    path: "inference session list",
    risk: "low",
    reason: "Read-only listing of active sessions",
  },
  { path: "mcp reload", risk: "low" },
  { path: "mcp add", risk: "high" },
  { path: "mcp auth", risk: "medium" },
  { path: "mcp remove", risk: "low" },
  {
    path: "memory items create",
    risk: "medium",
    reason:
      "Creates a memory item that persists into assistant memory and is embedded for recall",
  },
  {
    path: "memory items update",
    risk: "medium",
    reason:
      "Rewrites a memory item's content/metadata and re-embeds it for recall",
  },
  {
    path: "memory items delete",
    risk: "medium",
    reason:
      "Soft-deletes a memory item and removes its embeddings from the recall index (restorable via 'memory items update --status active')",
  },
  {
    path: "memory v2 reembed",
    risk: "medium",
    reason: "Enqueues bulk re-embedding of every concept page",
  },
  {
    path: "memory v2 reembed-skills",
    risk: "medium",
    reason:
      "Synchronously re-seeds the v2 skill catalog into the concept-page collection",
  },
  {
    path: "memory v2 activation",
    risk: "medium",
    reason: "Enqueues recompute of persisted activation state",
  },
  {
    path: "memory v2 validate",
    risk: "low",
    reason: "Read-only diagnostic walk over concept pages and edges",
  },
  {
    path: "memory v3 backfill-sections",
    risk: "medium",
    reason:
      "Embeds every page's sections into the v3 dense store and advances the maintain checkpoint",
  },
  {
    path: "memory v3 eval",
    risk: "medium",
    reason:
      "Reads recent conversation turns and memory contents and writes them to eval packet/key files",
  },
  {
    path: "memory v3 rebuild-index",
    risk: "low",
    reason:
      "Invalidates the in-memory v3 section lanes so they rebuild on the next turn",
  },
  {
    path: "memory retrospective run",
    risk: "medium",
    reason:
      "Forks a conversation and wakes a retrospective agent that calls remember on uncovered facts",
  },
  {
    path: "memory worker start",
    risk: "medium",
    reason: "Spawns a background process that processes memory jobs",
  },
  {
    path: "memory worker stop",
    risk: "low",
    reason: "Sends SIGTERM to the memory worker process",
  },
  {
    path: "memory worker status",
    risk: "low",
    reason: "Read-only liveness probe via PID file",
  },
  {
    path: "monitoring start",
    risk: "medium",
    reason: "Spawns a background process that samples memory and disk",
  },
  {
    path: "monitoring stop",
    risk: "low",
    reason: "Sends SIGTERM to the resource monitor process",
  },
  {
    path: "monitoring status",
    risk: "low",
    reason: "Read-only liveness probe via PID file",
  },
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
  {
    path: "schedules create",
    risk: "medium",
    reason:
      "Creates a new recurring schedule that fires assistant-side messages",
  },
  {
    path: "schedules update",
    risk: "medium",
    reason:
      "Updates schedule fields (expression, message, mode, script) and mutates assistant schedule state",
  },
  {
    path: "schedules enable",
    risk: "medium",
    reason: "Enables a schedule and mutates assistant schedule state",
  },
  {
    path: "schedules disable",
    risk: "medium",
    reason: "Disables a schedule and mutates assistant schedule state",
  },
  {
    path: "schedules cancel",
    risk: "medium",
    reason: "Cancels a pending schedule and mutates assistant schedule state",
  },
  {
    path: "schedules delete",
    risk: "medium",
    reason:
      "Permanently removes a schedule and its run history from assistant state",
  },
  {
    path: "schedules execute",
    risk: "high",
    reason:
      "Triggers immediate schedule execution. Script-mode schedules shell out " +
      "via sh -c on the host, and the schedule ID arg is opaque to the " +
      "classifier — must conservatively assume host shell execution",
  },
  {
    path: "schedules worker start",
    risk: "medium",
    reason: "Spawns a background process that runs scheduled jobs",
  },
  {
    path: "schedules worker stop",
    risk: "medium",
    reason:
      "Disables schedules.worker.enabled and sends SIGTERM to the schedule worker process",
  },
  {
    path: "schedules worker status",
    risk: "low",
    reason: "Read-only liveness probe via PID file",
  },
  { path: "sequence pause", risk: "medium" },
  { path: "sequence resume", risk: "medium" },
  { path: "sequence cancel-enrollment", risk: "medium" },
  { path: "sequence guardrails set", risk: "medium" },
  {
    path: "plugins install",
    risk: "high",
    reason: "Fetches and installs external plugin code from GitHub",
  },
  {
    path: "plugins uninstall",
    risk: "medium",
    reason: "Removes an installed plugin and all its files from the workspace",
  },
  {
    path: "plugins upgrade",
    risk: "high",
    reason: "Fetches and re-installs external plugin code from GitHub",
  },
  {
    path: "plugins disable",
    risk: "medium",
    reason:
      "Disables a plugin by creating a .disabled sentinel file in the workspace",
  },
  {
    path: "plugins enable",
    risk: "medium",
    reason: "Re-enables a plugin by removing the .disabled sentinel file",
  },
  { path: "skills install", risk: "high" },
  { path: "skills uninstall", risk: "medium" },
  { path: "skills add", risk: "high" },
  { path: "stt transcribe", risk: "medium" },
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

// `config set` is a medium-risk state mutation, but writing an `llm.*`,
// `services.*`, `gateway.*`, or `ingress.*` config path rewires the assistant's
// own model routing, service modes, gateway behavior, or public-URL/webhook/
// OAuth-callback routing (ingress.publicBaseUrl). Self-misconfiguration of these
// paths can silently break integrations or redirect inbound webhook/callback
// traffic, so classify them as high — a privilege/trust-relevant mutation. The
// pattern matches the config-path positional (the first non-flag argument to
// `config set`), including bare domain roots and any dotted subpath.
const configSetArgRules: ArgRule[] = [
  {
    id: "assistant-config-set:privileged-path",
    valuePattern: String.raw`^(llm|services|gateway|ingress)(\.|$)`,
    risk: "high",
    reason:
      "Rewires the assistant's own model routing (llm.*), service modes (services.*), gateway behavior (gateway.*), or public-URL/webhook/OAuth-callback routing (ingress.publicBaseUrl); self-misconfiguration can silently break integrations or redirect inbound traffic",
  },
];
getExistingPath(spec, "config set").argRules = configSetArgRules;

const assistantBashArgRules: ArgRule[] = [
  {
    id: "assistant-bash:command",
    valuePattern: String.raw`^(?!bash$|--help$|-h$).+`,
    risk: "high",
    reason: "Executes arbitrary shell command",
  },
];
getExistingPath(spec, "bash").argRules = assistantBashArgRules;

// `schedules update` is medium-risk as a state mutation, but updates that
// install or switch to a script payload persist host shell execution for a
// later schedule fire — classify those as high like `bash`.
const scheduleUpdateArgRules: ArgRule[] = [
  {
    id: "assistant-schedules-update:script",
    flags: ["--script"],
    risk: "high",
    reason:
      "Persists an arbitrary shell command that the schedule executes on fire",
  },
  {
    id: "assistant-schedules-update:mode-script",
    flags: ["--mode"],
    valuePattern: "^script$",
    risk: "high",
    reason:
      "Switches the schedule to script mode (host shell execution on fire)",
  },
];
const scheduleUpdateNode = getExistingPath(spec, "schedules update");
scheduleUpdateNode.argRules = scheduleUpdateArgRules;
// Both rule flags consume the next token as a value; declare them so the
// arg parser pairs `--mode script` / `--script <cmd>` correctly.
scheduleUpdateNode.argSchema = { valueFlags: ["--mode", "--script"] };

// `schedules create` mirrors `schedules update`: a create that installs a
// script payload persists host shell execution for a later fire — high like
// `bash`.
const scheduleCreateArgRules: ArgRule[] = [
  {
    id: "assistant-schedules-create:script",
    flags: ["--script"],
    risk: "high",
    reason:
      "Persists an arbitrary shell command that the schedule executes on fire",
  },
  {
    id: "assistant-schedules-create:mode-script",
    flags: ["--mode"],
    valuePattern: "^script$",
    risk: "high",
    reason:
      "Switches the schedule to script mode (host shell execution on fire)",
  },
];
const scheduleCreateNode = getExistingPath(spec, "schedules create");
scheduleCreateNode.argRules = scheduleCreateArgRules;
scheduleCreateNode.argSchema = { valueFlags: ["--mode", "--script"] };

export default spec;
