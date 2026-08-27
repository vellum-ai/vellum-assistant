/**
 * Build a stand-in `Conversation` for tests that exercise functions taking the
 * live conversation (surface helpers, the tool executor, post-execution
 * hooks).
 *
 * Those functions read a handful of fields off a `Conversation` that has ~150
 * members, so a test double supplies only what the function under test
 * touches. `Partial<Conversation>` keeps the literal contextually typed —
 * field types and callback parameter types are still checked against the real
 * class, and a renamed or retyped member still breaks the build — while the
 * single assertion here confines the unavoidable widening to one place
 * instead of one `as unknown as` per test file.
 *
 * The `Conversation` import is type-only, so this helper contributes nothing
 * to the runtime import graph.
 */

import type { Conversation } from "../../daemon/conversation.js";
import type { ChannelCapabilities } from "../../daemon/conversation-runtime-assembly.js";

/**
 * `TExtra` carries test-only fields a double hangs off the same object
 * (recorded calls, captured messages) through to the return type, so a caller
 * can still read `ctx.processMessageCalls` off the result.
 */
export function asConversation<TExtra extends object = object>(
  mock: Partial<Conversation> & TExtra,
): Conversation & TExtra {
  // Trust accessors, derived from the double's own fields exactly as the real
  // class derives them, so a double that sets (or later mutates) the fields
  // resolves the same values production would. Supplied only when the double
  // does not bring its own, and reading through `merged` rather than `mock`
  // so a test that reassigns the fields on the returned object is honoured.
  const merged: Partial<Conversation> & TExtra = {
    getTurnTrust: () => merged.currentTurnTrustContext,
    getTrustContext: () => merged.trustContext,
    getTurnOrRestingTrust: () =>
      merged.currentTurnTrustContext ?? merged.trustContext,
    isStale: () => false,
    hasInFlightWork: () => false,
    ...mock,
  };
  return merged as unknown as Conversation & TExtra;
}

/**
 * Fill a partial capability set out to a full `ChannelCapabilities`.
 *
 * Surface tests care about `channel` and `supportsDynamicUi`; the remaining
 * required fields are noise at the call site but must be present for the
 * value to be a real `ChannelCapabilities`. Defaults are the conservative
 * ones (no dashboard, no voice), so a test that forgets to opt in gets the
 * restrictive branch rather than a silently permissive one.
 */
export function mockChannelCapabilities(
  caps: Pick<ChannelCapabilities, "channel" | "supportsDynamicUi"> &
    Partial<ChannelCapabilities>,
): ChannelCapabilities {
  return { dashboardCapable: false, supportsVoiceInput: false, ...caps };
}
