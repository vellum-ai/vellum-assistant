import type { DictationOfferAnswer } from "@vellumai/ipc-contract";

import {
  clearDictationOffer,
  useDictationOfferStore,
} from "@/domains/chat/voice/dictation-offer-store";
import type { DictationOffer } from "@/domains/chat/voice/dictation-offer-store";
import { frontmostApp, quitApp } from "@/runtime/running-apps";
import {
  insertTextIntoFrontApp,
  undoInFrontApp,
} from "@/runtime/text-insertion";

export interface DictationOfferActionDeps {
  frontmostApp: typeof frontmostApp;
  quitApp: typeof quitApp;
  undoInFrontApp: typeof undoInFrontApp;
  insertTextIntoFrontApp: typeof insertTextIntoFrontApp;
}

const defaultDeps: DictationOfferActionDeps = {
  frontmostApp,
  quitApp,
  undoInFrontApp,
  insertTextIntoFrontApp,
};

/**
 * Act on an answer to the offer. Every answer takes the offer down, including
 * the ones that act on nothing here: the companion draws it until this side
 * stops publishing it.
 *
 * Acts only on the offer the press was drawn against. The surface can be a
 * frame behind this window, so a press can arrive after a new hold has put
 * different words up, and answering those would act on words the user never
 * saw. That press is dropped and the standing offer is left alone.
 *
 * Returns what was done, for the log and the tests: `replaced` (the other
 * app's paste undone and Vellum's words inserted), `quit` (the other app
 * asked to quit), `copied` (main has put the words on the pasteboard),
 * `dismissed`, `moved-on` (the user has since left the application the paste
 * went into, so nothing is touched), `stale` (the press named an offer that
 * no longer stands), or `none` (no offer stood at all).
 *
 * An answer that does not belong to the offer standing is treated as a
 * dismissal rather than acted on: the card picks its answers from the
 * offer's reason, so the only way to see one is a press racing an offer that
 * has already been replaced.
 */
export async function answerDictationOffer(
  answer: DictationOfferAnswer,
  offerId: string,
  deps: DictationOfferActionDeps = defaultDeps,
): Promise<
  "replaced" | "quit" | "copied" | "dismissed" | "moved-on" | "stale" | "none"
> {
  const standing = useDictationOfferStore.getState().offer;
  if (standing === null) {
    return "none";
  }
  if (standing.id !== offerId) {
    console.info(
      `dictation: offer answer ${answer} dropped, names an offer that no longer stands`,
    );
    return "stale";
  }
  const offer = clearDictationOffer();
  if (offer === null) {
    return "none";
  }
  // The clipboard write itself is main's, done before this command was sent:
  // main holds the pasteboard, and the surface's window never takes focus,
  // which is what an async clipboard write in a renderer needs. All that is
  // left here is to stop offering the words.
  if (answer === "copy") {
    return "copied";
  }
  if (answer === "dismiss" || offer.reason !== "claimed") {
    return "dismissed";
  }
  if (answer === "quit") {
    void deps.quitApp(offer.app.bundleId);
    return "quit";
  }
  return replaceWithOffer(offer, deps);
}

/**
 * The other app's paste is the last edit in the application the hold was
 * made in, and a paste is one undo step, so undoing it and inserting Vellum's
 * words is what "use this instead" means.
 *
 * Only while that application is still in front. The undo goes to whatever
 * is in front, and an application the user has moved to since would lose an
 * edit of its own. The undo itself is not checked: an application that
 * refuses it still gets the words, which is closer to what was asked than
 * nothing.
 */
async function replaceWithOffer(
  offer: Extract<DictationOffer, { reason: "claimed" }>,
  deps: DictationOfferActionDeps,
): Promise<"replaced" | "moved-on"> {
  const front = await deps.frontmostApp();
  if (offer.frontApp !== null && front !== offer.frontApp) {
    console.info(
      `dictation: offer not used, front app moved from ${offer.frontApp} to ${front ?? "none"}`,
    );
    return "moved-on";
  }
  await deps.undoInFrontApp();
  await deps.insertTextIntoFrontApp(offer.text);
  return "replaced";
}
