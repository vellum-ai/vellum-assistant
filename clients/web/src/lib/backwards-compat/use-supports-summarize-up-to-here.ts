/**
 * Backwards-compat gate: the per-message "Summarize up to here" action.
 *
 * Vellum Assistant 0.10.8 added `POST /v1/conversations/summarize` (the
 * endpoint that summarizes a conversation's working memory up to a chosen
 * message). Older assistants 404 that route, so the web app hides the
 * per-message hover / long-press "Summarize up to here" affordance — the
 * transcript renders exactly as it did before the feature, with no action
 * to invoke and no error surfaced.
 *
 * This is a write action: the endpoint mutates the assistant's live
 * context. It gates at the callback source in `active-chat-view.tsx` —
 * with the gate `false` no `onSummarizeUpToHere` is provided, so the
 * hover button and long-press sheet item never render and the confirm
 * dialog is unreachable. A render hook (not the `assistantSupports`
 * snapshot) so the action appears the moment the version hydrates.
 *
 * MIN_VERSION is 0.10.8: the endpoint first shipped in v0.10.8-staging.1
 * (PR #36929); v0.10.7 and older 404 it.
 */
import { useAssistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.10.8";

export function useSupportsSummarizeUpToHere(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
