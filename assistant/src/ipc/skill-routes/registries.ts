/**
 * Skill IPC routes — `host.registries.*` surface.
 *
 * Lets an out-of-process skill install tools, HTTP routes, shutdown hooks
 * and session-tracking signals into the daemon's in-memory registries. When
 * a {@link MeetHostSupervisor} is attached (production lazy-external path),
 * the register_* handlers short-circuit because the manifest loader has
 * already installed proxy entries that round-trip via `skill.dispatch_*`;
 * the handler simply pins the incoming connection on the supervisor so
 * dispatches have a target. When no supervisor is attached (tests, boot
 * race), the handler installs in-memory proxies whose stubs surface a
 * 501/501-equivalent error — those paths are not exercised end-to-end.
 *
 * `report_session_started` / `report_session_ended` keep an internal counter
 * mirrored to the supervisor's own counter (which is the source of truth
 * once attached); the local set backs tests that exercise the IPC routes
 * without a supervisor.
 */

import { z } from "zod";

import type { MeetHostSupervisor } from "../../daemon/meet-host-supervisor.js";
import { registerShutdownHook } from "../../daemon/shutdown-registry.js";
import { registerSkillRoute } from "../../runtime/skill-route-registry.js";
import { registerSkillTools } from "../../tools/registry.js";
import { finalizeTool } from "../../tools/tool-defaults.js";
import { ToolDefinitionSchema } from "../../tools/types.js";
import { getLogger } from "../../util/logger.js";
import type { SkillIpcRoute } from "../skill-ipc-types.js";
import type { SkillIpcConnection } from "../skill-server.js";

const log = getLogger("skill-routes-registries");

// `skillId` lives at the params level rather than per-tool: a single
// `register_tools` IPC frame is always one skill's batch, ownership flows
// through `registerSkillTools(skillId, tools)` into the registry's
// `ownersByName` map, and the tools themselves stay free of owner
// metadata so callers cannot spoof ownership by forging a field on the
// manifest. Only skill-owned tools cross IPC — plugin and MCP tools live
// in-process on the assistant side.
const RegisterToolsParams = z.object({
  skillId: z.string().min(1),
  tools: z.array(ToolDefinitionSchema).min(1),
});

const RegisterSkillRouteParams = z.object({
  patternSource: z.string().min(1),
  // `new RegExp(patternSource)` alone silently drops i/m/g/s/u/y flags from
  // the skill-side RegExp — keep them as a separate field to survive IPC.
  patternFlags: z.string().default(""),
  methods: z.array(z.string().min(1)).min(1),
  skillId: z.string().min(1).optional(),
});

const RegisterShutdownHookParams = z.object({
  name: z.string().min(1),
});

const ReportSessionParams = z.object({
  meetingId: z.string().min(1),
});

// ── Session counter ───────────────────────────────────────────────────

/**
 * Fallback active-session set. Keyed by meetingId so duplicate
 * `report_session_started` calls are idempotent and `report_session_ended`
 * for an unknown id is a no-op. Used in the narrow window before
 * `meet-host-startup.ts` registers the supervisor and in tests that
 * exercise the IPC routes in isolation. Also backs the test-only peek
 * helper since the supervisor owns its own counter.
 */
const activeSessions = new Set<string>();

/**
 * Supervisor injected by `meet-host-startup.ts` at daemon boot. When set,
 * IPC session-report frames are forwarded to it so its active-session
 * counter and idle-shutdown timer stay in sync with the routes; the
 * `register_*` handlers also pin the incoming connection on the
 * supervisor so daemon→skill dispatches have a target. When unset (boot
 * race, tests), the fallback set above is mutated directly and the
 * register_* handlers fall back to in-memory proxy installation.
 */
type SessionSupervisor = Pick<
  MeetHostSupervisor,
  | "reportSessionStarted"
  | "reportSessionEnded"
  | "activeSessionCount"
  | "setActiveConnection"
>;

let sessionSupervisor: SessionSupervisor | null = null;

/**
 * Install a {@link MeetHostSupervisor} as the session-report sink and
 * connection holder for daemon→skill dispatch. The IPC routes still
 * maintain their fallback {@link Set} for diagnostics, but the
 * supervisor's counter is the source of truth for the `activeCount`
 * returned to the skill. Passing `null` detaches the supervisor — used
 * by tests that want to exercise the fallback path cleanly.
 */
export function setMeetHostSupervisorForSessionReports(
  supervisor: SessionSupervisor | null,
): void {
  sessionSupervisor = supervisor;
}

function reportSessionStarted(meetingId: string): number {
  if (sessionSupervisor) {
    sessionSupervisor.reportSessionStarted(meetingId);
    const count = sessionSupervisor.activeSessionCount;
    log.info(
      { meetingId, activeCount: count },
      "Skill reported session started",
    );
    return count;
  }
  activeSessions.add(meetingId);
  log.info(
    { meetingId, activeCount: activeSessions.size },
    "Skill reported session started",
  );
  return activeSessions.size;
}

function reportSessionEnded(meetingId: string): number {
  if (sessionSupervisor) {
    sessionSupervisor.reportSessionEnded(meetingId);
    const count = sessionSupervisor.activeSessionCount;
    log.info({ meetingId, activeCount: count }, "Skill reported session ended");
    return count;
  }
  activeSessions.delete(meetingId);
  log.info(
    { meetingId, activeCount: activeSessions.size },
    "Skill reported session ended",
  );
  return activeSessions.size;
}

/** Test-only: drop all active sessions between test cases. */
export function __resetActiveSessionsForTesting(): void {
  activeSessions.clear();
  sessionSupervisor = null;
}

/** Test-only: peek at the current active set size. */
export function __getActiveSessionCountForTesting(): number {
  return activeSessions.size;
}

// ── Handlers ──────────────────────────────────────────────────────────

async function handleRegisterTools(
  params: Record<string, unknown> | undefined,
  connection?: unknown,
): Promise<{ registered: string[] }> {
  const { skillId, tools } = RegisterToolsParams.parse(params);
  const conn = connection as SkillIpcConnection | undefined;

  // Finalize before branching so both the supervisor short-circuit and
  // the in-memory registration path see a `Tool[]` with guaranteed
  // `name`. The execute closure arrives as a no-op error closure from
  // `finalizeTool`; the production (supervisor) path replaces it with
  // the dispatching closure installed by the manifest loader at boot.
  const proxies = tools.map((t) => finalizeTool(t));

  // Supervisor short-circuit: when a supervisor is registered, the
  // manifest loader has already installed proxy tools at daemon boot.
  // Re-installing here would double-register and clobber the manifest's
  // execute closures with these placeholder ones. Pin the incoming
  // connection on the supervisor so daemon→skill dispatches have a
  // target, then return the manifest-declared tool names.
  if (sessionSupervisor) {
    if (conn) sessionSupervisor.setActiveConnection(conn);
    log.info(
      {
        count: proxies.length,
        names: proxies.map((t) => t.name),
        ownerSkillId: skillId,
      },
      "Supervisor active: skipping in-memory tool re-registration; manifest proxies serve dispatches",
    );
    return { registered: proxies.map((t) => t.name) };
  }

  // `registerExternalTools` is only consumed inside `initializeTools()` at
  // daemon boot; IPC children connect after boot, so route through
  // `registerSkillTools` into the live registry the agent-loop reads from.
  // Owner is stamped registry-side from `skillId`; the proxy `Tool` objects
  // carry no owner field.
  const accepted = registerSkillTools(skillId, proxies);

  // `registerSkillTools` increments the registry refcount once per call;
  // mirror that on the connection so disconnect issues exactly one matching
  // decrement.
  if (conn && accepted.length > 0) {
    conn.addSkillToolsOwner(skillId);
  }

  log.info(
    {
      count: accepted.length,
      names: accepted.map((t) => t.name),
      ownerSkillId: skillId,
    },
    "Registered skill proxy tools via IPC",
  );
  return { registered: accepted.map((t) => t.name) };
}

async function handleRegisterSkillRoute(
  params: Record<string, unknown> | undefined,
  connection?: unknown,
): Promise<{ patternSource: string; methods: string[] }> {
  const { patternSource, patternFlags, methods, skillId } =
    RegisterSkillRouteParams.parse(params);
  const conn = connection as SkillIpcConnection | undefined;

  // Supervisor short-circuit: route already installed by the manifest
  // loader; pin the connection and let the manifest's proxy handler call
  // supervisor.dispatchRoute over IPC.
  if (sessionSupervisor) {
    if (conn) sessionSupervisor.setActiveConnection(conn);
    log.info(
      { patternSource, patternFlags, methods, skillId },
      "Supervisor active: skipping in-memory route re-registration; manifest proxy serves dispatches",
    );
    return { patternSource, methods };
  }

  let pattern: RegExp;
  try {
    pattern = new RegExp(patternSource, patternFlags);
  } catch (err) {
    throw new Error(
      `Invalid skill-route pattern "${patternSource}" (flags "${patternFlags}"): ${String(err)}`,
    );
  }
  const handle = registerSkillRoute({
    pattern,
    methods,
    handler: async () => {
      // Only reached when no supervisor is attached (tests/boot race);
      // the supervisor short-circuit above keeps the manifest's
      // dispatching handler in place on the production path.
      return new Response(
        "Skill route dispatch requires an attached MeetHostSupervisor",
        { status: 501 },
      );
    },
  });
  // Retain the handle on the connection so disconnect revokes this route;
  // without it, reconnects accumulate routes with no owner to unregister them.
  conn?.addRouteHandle(skillId ?? conn.connectionId, handle);

  log.info(
    { patternSource, patternFlags, methods, skillId },
    "Registered skill proxy HTTP route via IPC",
  );
  return { patternSource, methods };
}

async function handleRegisterShutdownHook(
  params: Record<string, unknown> | undefined,
  connection?: unknown,
): Promise<{ name: string }> {
  const { name } = RegisterShutdownHookParams.parse(params);
  const conn = connection as SkillIpcConnection | undefined;

  // Supervisor short-circuit: shutdown hook already registered by the
  // manifest loader; just pin the connection so dispatches can flow.
  if (sessionSupervisor) {
    if (conn) sessionSupervisor.setActiveConnection(conn);
    log.info(
      { name },
      "Supervisor active: skipping shutdown-hook re-registration; manifest hook serves dispatches",
    );
    return { name };
  }

  registerShutdownHook(name, async (reason) => {
    // Only reached when no supervisor is attached; production attaches a
    // dispatching hook via the manifest loader.
    log.info(
      { name, reason },
      "Skill shutdown hook fired (no-op without attached MeetHostSupervisor)",
    );
  });
  return { name };
}

async function handleReportSessionStarted(
  params?: Record<string, unknown>,
): Promise<{ activeCount: number }> {
  const { meetingId } = ReportSessionParams.parse(params);
  return { activeCount: reportSessionStarted(meetingId) };
}

async function handleReportSessionEnded(
  params?: Record<string, unknown>,
): Promise<{ activeCount: number }> {
  const { meetingId } = ReportSessionParams.parse(params);
  return { activeCount: reportSessionEnded(meetingId) };
}

// ── Route exports ─────────────────────────────────────────────────────

export const registerToolsRoute: SkillIpcRoute = {
  method: "host.registries.register_tools",
  handler: handleRegisterTools,
};

export const registerSkillRouteRoute: SkillIpcRoute = {
  method: "host.registries.register_skill_route",
  handler: handleRegisterSkillRoute,
};

export const registerShutdownHookRoute: SkillIpcRoute = {
  method: "host.registries.register_shutdown_hook",
  handler: handleRegisterShutdownHook,
};

export const reportSessionStartedRoute: SkillIpcRoute = {
  method: "host.registries.report_session_started",
  handler: handleReportSessionStarted,
};

export const reportSessionEndedRoute: SkillIpcRoute = {
  method: "host.registries.report_session_ended",
  handler: handleReportSessionEnded,
};

export const registriesRoutes: SkillIpcRoute[] = [
  registerToolsRoute,
  registerSkillRouteRoute,
  registerShutdownHookRoute,
  reportSessionStartedRoute,
  reportSessionEndedRoute,
];
