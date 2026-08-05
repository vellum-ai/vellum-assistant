/**
 * Backwards-compat gate: the multilingual speech-recognition default.
 *
 * Assistant 0.12.0 resolves an unset `services.stt.language` to nova-3
 * code-switching on Deepgram and the managed relay (`effectiveSttLanguage` in
 * `assistant/src/providers/speech-to-text/resolve.ts`). Older assistants send
 * no language at all on that path, which Deepgram decodes as English.
 *
 * The gate exists because the default is invisible in config: both versions
 * report the same `languageSelection: "manual"` capability and the same unset
 * language, so nothing in the payload distinguishes them. Only the assistant
 * version says which behavior an unset value will actually produce.
 *
 * Without it, a current bundle pointed at a pre-0.12.0 assistant would relabel
 * the default row "Multilingual (default)" while that assistant still decodes
 * English, and would withhold the first-run language suggestion from exactly
 * the speakers it exists for: a Hindi-locale user would be told nothing and
 * transcribed as English. Ungated, the newer of the two claims would be the
 * one shown, and it would be the wrong one.
 *
 * Scoped to the owning assistant (see `useAssistantScopedSupports` in
 * `./utils.ts`) so a version fetched for one assistant never describes
 * another's defaults mid-switch, and conservative until the version hydrates:
 * unknown renders the English-framed rows, which is what every assistant did
 * before 0.12.0.
 */
import {
  assistantScopedSupports,
  useAssistantScopedSupports,
  whenAssistantVersionKnownFor,
} from "@/lib/backwards-compat/utils";

export const MIN_VERSION = "0.12.0";

/**
 * Returns `true` when the assistant owning the speech settings resolves an
 * unset language to code-switching rather than English. Callers pass it to
 * the language catalog, which reframes the default row and narrows the
 * locale suggestion only when it holds.
 */
export function useSupportsMultilingualSttDefault(
  ownerAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, ownerAssistantId);
}

/**
 * The same answer, read against a resolved version, for the write path.
 *
 * Reads tolerate the conservative `false`-on-unknown default: they re-run
 * the moment the version hydrates, so the worst case is the English framing
 * shown for an instant. The write cannot, because what it persists is a
 * one-way door. `config_patch` cannot delete `services.stt.language`, so a
 * default pick that lands during the unknown window would write explicit
 * `"en"` and pin English on an assistant whose actual default is
 * code-switching, until the user notices and picks again.
 */
export async function resolveSupportsMultilingualSttDefault(
  ownerAssistantId: string | null | undefined,
): Promise<boolean> {
  // Scoped to the same assistant the gate then reads against. An unscoped
  // wait would be satisfied by a version still held for whichever assistant
  // the user was viewing a moment ago, and the owner mismatch would send this
  // write down the legacy path for an assistant that never needed it.
  await whenAssistantVersionKnownFor(ownerAssistantId);
  return assistantScopedSupports(MIN_VERSION, ownerAssistantId);
}
