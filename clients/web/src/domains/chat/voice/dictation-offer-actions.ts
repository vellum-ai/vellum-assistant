import type { DictationOfferAnswer } from "@vellumai/ipc-contract";

import { clearDictationOffer } from "@/domains/chat/voice/dictation-offer-store";
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
 * the one that acts on nothing: the companion draws it until this side stops
 * publishing it.
 *
 * Returns what was done, for the log and the tests: `replaced` (the other
 * app's paste undone and Vellum's words inserted), `quit` (the other app
 * asked to quit), `dismissed`, `moved-on` (the user has since left the
 * application the paste went into, so nothing is touched), or `none` (no
 * offer stood).
 */
export async function answerDictationOffer(
  answer: DictationOfferAnswer,
  deps: DictationOfferActionDeps = defaultDeps,
): Promise<"replaced" | "quit" | "dismissed" | "moved-on" | "none"> {
  const offer = clearDictationOffer();
  if (offer === null) {
    return "none";
  }
  if (answer === "dismiss") {
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
  offer: DictationOffer,
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
