/**
 * Backwards-compat gate: persisting the text composer's ambient camera keeps.
 *
 * While the composer's Eyes viewfinder is open, every frame the gate keeps is
 * uploaded over the ordinary attachment route and then handed to
 * `POST /v1/assistants/:assistant_id/conversations/:id/sight-frame`, which
 * writes it into the conversation as its own standalone user message that runs
 * no turn. The upload half works against any assistant; the route does not.
 *
 * A WRITE gate, so it withholds the behavior rather than letting it fail (see
 * docs/BACKWARDS_COMPAT.md): below `MIN_VERSION` nothing is uploaded and
 * nothing is persisted. The hook form is enough because the stream runs in a
 * rendered effect, which is withhold-by-default: an unhydrated version reads
 * `false` and no keep moves, and the first render after hydration starts the
 * stream. An assistant that predates the route answers 404 to every keep, and
 * an ungated stream would upload a frame every few seconds and strand each one
 * as a row nothing will ever collect.
 *
 * Separate from `use-supports-sight-stream.ts`, which gates the live-voice
 * `sight_frame` socket frame. The two surfaces reach the same daemon-side
 * persist by different transports, and each transport landed in its own build,
 * so neither floor can speak for the other.
 *
 * Scoped to the assistant that owns the conversation, so a version held for the
 * outgoing assistant cannot authorize a persist against the incoming one.
 *
 * Delete this gate, and the `useSupportsSightPersist` term in
 * `domains/chat/sight/use-sight-keeps.ts`, once the minimum supported assistant
 * is >= MIN_VERSION.
 */
import { useAssistantScopedSupports } from "./utils";

/**
 * PLACEHOLDER, and open: `0.0.0-unpinned` sits below every version an assistant
 * can report, so the gate admits all of them and withholds nothing.
 *
 * A pinned floor is one published dev build's whole version string,
 * `<base>-dev.<YYYYMMDDHHMM>.<sha>`, naming the first Dev Release that carries
 * the daemon route. It cannot be written before that build exists: `main`
 * carries the base of the last cut, so a build with the route and one from
 * before it are both named `<base>-dev.*` and only the suffix separates them,
 * and a dev version's timestamp records when the release workflow computed it
 * rather than what the build contains, so a bare minute admits a later-stamped
 * build from an older commit. `use-supports-sight-stream.ts` carries the long
 * form of that reasoning, including the three tidier constants that are each
 * wrong in a different direction.
 *
 * Pinning is this one line, plus the `test.todo` shape row in the colocated
 * test and the version cell of this gate's row in docs/BACKWARDS_COMPAT.md.
 */
export const MIN_VERSION = "0.0.0-unpinned";

/**
 * Returns `true` when the assistant owning the conversation
 * (`conversationAssistantId`) serves the sight-frame route, so every keep the
 * composer's camera makes can be persisted as its own message.
 *
 * On the `false` branch (below `MIN_VERSION`, or any of
 * `useAssistantScopedSupports`'s conservative unknown/mismatch cases) no keep
 * is uploaded and the ambient stream is simply absent; the camera still hands
 * a frame to an outgoing send.
 */
export function useSupportsSightPersist(
  conversationAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, conversationAssistantId);
}
