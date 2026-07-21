/**
 * Canonical ordering contract for the first-party default injectors.
 *
 * Every default injector — across the domain plugins (`turn-context`,
 * `workspace`, `documents`, `channel`, `session`) and the memory plugin — pulls
 * its `order` from this single table, so the global per-turn injection sequence
 * has one source of truth. The injector registry unions every plugin's
 * injectors and sorts by `order` ascending (see `plugins/injector-registry.ts`),
 * and `injector-registry-order-guard.test.ts` locks the resulting sequence.
 *
 * | name                       | order | placement            |
 * | -------------------------- | ----- | -------------------- |
 * | `disk-pressure-warning`    | 5     | prepend-user-tail    |
 * | `workspace-context`        | 10    | prepend-user-tail    |
 * | `background-turn`          | 15    | prepend-user-tail    |
 * | `unified-turn-context`     | 20    | prepend-user-tail    |
 * | `config-quarantine-notice` | 25    | prepend-user-tail    |
 * | `pkb-context`              | 30    | after-memory-prefix  |
 * | `pkb-reminder`             | 35    | after-memory-prefix  |
 * | `memory-v2-static`         | 38    | after-memory-prefix  |
 * | `now-md`                   | 40    | after-memory-prefix  |
 * | `active-documents`         | 45    | prepend-user-tail    |
 * | `document-comments`        | 46    | prepend-user-tail    |
 * | `subagent-status`          | 50    | append-user-tail     |
 * | `slack-messages`           | 60    | replace-run-messages |
 * | `thread-focus`             | 70    | append-user-tail     |
 *
 * `order` matches the intended final-content ordering: lower `order` ends up
 * closer to the top of the user message's content (for prepends), and within
 * `after-memory-prefix` each successive splice lands at the memory boundary —
 * so higher-`order` blocks push earlier splices away and end up closer to the
 * memory prefix themselves. For appends, ascending `order` is the natural
 * left-to-right append sequence.
 *
 * Gaps between slots leave room for future injectors to slot in at granular
 * positions (e.g. `25` between unified-turn-context and pkb) without
 * renumbering. The memory-v3 injectors sit far above this range (1000 / 1001).
 */
export const DEFAULT_INJECTOR_ORDER = {
  diskPressureWarning: 5,
  workspaceContext: 10,
  backgroundTurn: 15,
  unifiedTurnContext: 20,
  configQuarantineNotice: 25,
  configValidationResetNotice: 26,
  pkbContext: 30,
  pkbReminder: 35,
  memoryV2Static: 38,
  nowMd: 40,
  activeDocuments: 45,
  documentComments: 46,
  subagentStatus: 50,
  slackMessages: 60,
  threadFocus: 70,
} as const satisfies Record<string, number>;
