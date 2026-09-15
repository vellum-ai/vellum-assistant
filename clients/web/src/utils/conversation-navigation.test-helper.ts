/**
 * Test doubles for `@/utils/conversation-navigation`: {@link navigateDouble}
 * for the suites that pass one navigator in, and
 * {@link conversationNavigationMock} for those that replace the module
 * wholesale.
 *
 * `mock.module` is process-global in bun, and a factory that omits an export
 * hides it from every importer in the process. The module's own type is this
 * factory's return type, so an export added to the module without a default
 * here is one compile error rather than an `undefined` that six suites read
 * as a passing branch.
 *
 * `activation-list-route.test.tsx` spreads the real module instead: it restores
 * the real functions in `afterAll`, so it holds them already.
 */

import { mock } from "bun:test";

type ConversationNavigationModule =
  typeof import("@/utils/conversation-navigation");

/**
 * A `PathNavigate` spy. Both of its overloads are recorded, so a suite can
 * tell a pop (`-1`) from a path navigation by the argument it was called with,
 * and the options carry history state as well as `replace`.
 */
export function navigateDouble() {
  return mock(
    (
      _to: string | number,
      _options?: { replace?: boolean; state?: unknown },
    ) => {},
  );
}

/** The id the draft-minting stubs hand back when a suite doesn't read it. */
const DRAFT_CONVERSATION_ID = "draft-conversation";

/**
 * Every export of the navigation module, defaulted to do nothing, with
 * `overrides` on top for the stubs and spies a suite actually observes.
 */
export function conversationNavigationMock(
  overrides: Partial<ConversationNavigationModule> = {},
): ConversationNavigationModule {
  return {
    currentPathname: () => "",
    currentEntryState: () => null,
    clearAppViewer: () => {},
    dropAppFromRoute: () => {},
    keepOpenAppBesideConversation: () => false,
    exitAppSplit: () => {},
    revealConversationView: () => {},
    keptAppId: () => null,
    navigateToConversation: () => {},
    prepareFreshConversation: () => DRAFT_CONVERSATION_ID,
    navigateToNewConversation: () => DRAFT_CONVERSATION_ID,
    navigateFromApp: () => {},
    closeAppRoute: () => {},
    ...overrides,
  };
}
