/**
 * Default runtime injector plugin — bundles the existing injection chain
 * (workspace, unified turn context, PKB, NOW.md, subagent, Slack, thread focus)
 * as {@link Injector}s with fixed `order` values that third-party plugins can
 * slot against.
 *
 * Each injector here is a thin {@link Injector} that defers to the existing
 * helpers in `conversation-runtime-assembly.ts` when invoked by the runtime
 * injection chain. `produce()` currently returns `null` because the concrete
 * per-turn inputs (the `options` bag passed to `applyRuntimeInjections`) are
 * not yet threaded through {@link TurnContext}; later PRs in the
 * agent-plugin-system plan lift each per-turn input into context state and
 * move the helper's real body into the corresponding injector.
 *
 * The value delivered by this PR is the **ordering contract**:
 *
 * | name                     | order |
 * | ------------------------ | ----- |
 * | `workspace-context`      | 10    |
 * | `unified-turn-context`   | 20    |
 * | `pkb`                    | 30    |
 * | `now-md`                 | 40    |
 * | `subagent-status`        | 50    |
 * | `slack-messages`         | 60    |
 * | `thread-focus`           | 70    |
 *
 * Third-party plugins may register additional {@link Injector}s at
 * arbitrary `order` values; the registry's `getInjectors()` returns all
 * injectors sorted ascending by `order`, so a plugin-registered injector at
 * `order: 25` reliably slots between `unified-turn-context` (20) and `pkb`
 * (30).
 *
 * Registration happens via a side-effect import in
 * `daemon/external-plugins-bootstrap.ts` so the default chain is present for
 * every assistant boot.
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 21).
 */

import type {
  InjectionBlock,
  Injector,
  Plugin,
  TurnContext,
} from "../types.js";

/**
 * Fixed order values for the seven default injectors. Exported so tests —
 * and any future integration code — can assert ordering without re-deriving
 * the constants.
 *
 * Gaps of 10 between slots leave room for third-party injectors to slot in
 * at granular positions (e.g. `25` between PKB and subagent) without
 * renumbering the defaults.
 */
export const DEFAULT_INJECTOR_ORDER = {
  workspaceContext: 10,
  unifiedTurnContext: 20,
  pkb: 30,
  nowMd: 40,
  subagentStatus: 50,
  slackMessages: 60,
  threadFocus: 70,
} as const satisfies Record<string, number>;

/**
 * `workspace-context` injector — order 10.
 *
 * Placeholder for `injectWorkspaceTopLevelContext`. Returns `null` until
 * later PRs lift workspace state onto {@link TurnContext}.
 */
export const workspaceContextInjector: Injector = {
  name: "workspace-context",
  order: DEFAULT_INJECTOR_ORDER.workspaceContext,
  async produce(_ctx: TurnContext): Promise<InjectionBlock | null> {
    return null;
  },
};

/**
 * `unified-turn-context` injector — order 20.
 *
 * Placeholder for `buildUnifiedTurnContextBlock`.
 */
export const unifiedTurnContextInjector: Injector = {
  name: "unified-turn-context",
  order: DEFAULT_INJECTOR_ORDER.unifiedTurnContext,
  async produce(_ctx: TurnContext): Promise<InjectionBlock | null> {
    return null;
  },
};

/**
 * `pkb` injector — order 30.
 *
 * Placeholder for the PKB context / system-reminder pair emitted by
 * `injectPkbContext` and `buildPkbReminder`.
 */
export const pkbInjector: Injector = {
  name: "pkb",
  order: DEFAULT_INJECTOR_ORDER.pkb,
  async produce(_ctx: TurnContext): Promise<InjectionBlock | null> {
    return null;
  },
};

/**
 * `now-md` injector — order 40.
 *
 * Placeholder for `injectNowScratchpad`.
 */
export const nowMdInjector: Injector = {
  name: "now-md",
  order: DEFAULT_INJECTOR_ORDER.nowMd,
  async produce(_ctx: TurnContext): Promise<InjectionBlock | null> {
    return null;
  },
};

/**
 * `subagent-status` injector — order 50.
 *
 * Placeholder for `injectSubagentStatus` / `buildSubagentStatusBlock`.
 */
export const subagentStatusInjector: Injector = {
  name: "subagent-status",
  order: DEFAULT_INJECTOR_ORDER.subagentStatus,
  async produce(_ctx: TurnContext): Promise<InjectionBlock | null> {
    return null;
  },
};

/**
 * `slack-messages` injector — order 60.
 *
 * Placeholder for the Slack chronological-transcript override assembled by
 * `assembleSlackChronologicalMessages`.
 */
export const slackMessagesInjector: Injector = {
  name: "slack-messages",
  order: DEFAULT_INJECTOR_ORDER.slackMessages,
  async produce(_ctx: TurnContext): Promise<InjectionBlock | null> {
    return null;
  },
};

/**
 * `thread-focus` injector — order 70.
 *
 * Placeholder for the Slack `<active_thread>` tail block assembled by
 * `assembleSlackActiveThreadFocusBlock`.
 */
export const threadFocusInjector: Injector = {
  name: "thread-focus",
  order: DEFAULT_INJECTOR_ORDER.threadFocus,
  async produce(_ctx: TurnContext): Promise<InjectionBlock | null> {
    return null;
  },
};

/**
 * Bundle every default injector into a single first-party plugin. Registered
 * at daemon startup via `external-plugins-bootstrap.ts`.
 *
 * Using one plugin per injector would inflate the registry and create
 * spurious registration-order dependencies; a single plugin keeps the
 * ordering contract entirely in the `order` field.
 */
export const defaultInjectorsPlugin: Plugin = {
  manifest: {
    name: "default-injectors",
    version: "1.0.0",
    requires: {
      pluginRuntime: "v1",
    },
  },
  injectors: [
    workspaceContextInjector,
    unifiedTurnContextInjector,
    pkbInjector,
    nowMdInjector,
    subagentStatusInjector,
    slackMessagesInjector,
    threadFocusInjector,
  ],
};
