/**
 * Inert stand-ins for every export of `@/utils/conversation-navigation`, for
 * the suites that replace that module wholesale.
 *
 * `mock.module` is process-global in bun, and a factory that omits an export
 * hides it from every importer in the process. The module's own type is this
 * factory's return type, so an export added to the module without a default
 * here is one compile error rather than an `undefined` that six suites read
 * as a passing branch.
 *
 * The module is named in a type position only. These suites mock it to keep
 * the conversation stores, haptics, and sound manager it pulls in out of
 * their process, so importing it for its values would put them back.
 *
 * `activation-list-route.test.tsx` spreads the real module rather than this
 * factory because it restores the real functions in `afterAll`, which means it
 * holds the real module already.
 *
 * ```ts
 * mock.module("@/utils/conversation-navigation", () =>
 *   conversationNavigationMock({ navigateToConversation: navigateSpy }),
 * );
 * ```
 */

type ConversationNavigationModule =
  typeof import("@/utils/conversation-navigation");

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
    keepOpenAppBesideConversation: () => false,
    revealConversationView: () => {},
    keptAppId: () => null,
    navigateToConversation: () => {},
    prepareFreshConversation: () => DRAFT_CONVERSATION_ID,
    navigateToNewConversation: () => DRAFT_CONVERSATION_ID,
    navigateFromApp: () => {},
    ...overrides,
  };
}
