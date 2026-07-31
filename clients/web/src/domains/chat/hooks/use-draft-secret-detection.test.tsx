/**
 * Tests for the draft secret-detection hook and its pure scan policy.
 *
 * Uses the real composer store (reset between tests) so the hook's store
 * subscription and dismissal lifecycle are exercised end to end. All tokens
 * are synthetic values invented for these tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { useComposerStore } from "@/domains/chat/composer-store";

import {
  SECRET_SCAN_MIN_DRAFT_LENGTH,
  scanDraftForSecrets,
  useDraftSecretDetection,
} from "./use-draft-secret-detection";

// Synthetic lookalike tokens — random strings matching detector shapes.
const SYNTHETIC_PROJECT_KEY =
  "sk-proj-Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3A";
const SYNTHETIC_GITHUB_TOKEN = "ghp_Zx9Wv8Ut7Sr6Qp5On4Ml3Kj2Ih1Gf0EdCbA9";

function setDraft(text: string) {
  act(() => {
    useComposerStore.getState().setInput(text);
  });
}

function renderDetection(
  conversationId: string | null = "conv-1",
  debounceMs = 0,
) {
  return renderHook(
    (props: { conversationId: string | null }) =>
      useDraftSecretDetection({
        conversationId: props.conversationId,
        debounceMs,
      }),
    { initialProps: { conversationId } },
  );
}

/**
 * A debounce that never elapses within a test — assertions passing under it
 * prove the scan ran synchronously rather than through the debounce timer.
 */
const NEVER_ELAPSES_MS = 60_000;

beforeEach(() => {
  useComposerStore.getState().setInput("");
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Pure scan policy
// ---------------------------------------------------------------------------

describe("scanDraftForSecrets", () => {
  test("skips drafts shorter than the minimum scan length", () => {
    const short = "a".repeat(SECRET_SCAN_MIN_DRAFT_LENGTH - 1);
    expect(scanDraftForSecrets(short)).toEqual([]);
  });

  test("detects a token in a long-enough draft", () => {
    const matches = scanDraftForSecrets(
      `here is ${SYNTHETIC_PROJECT_KEY} for you`,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.value).toBe(SYNTHETIC_PROJECT_KEY);
  });
});

// ---------------------------------------------------------------------------
// Hook — detection + dismissal lifecycle
// ---------------------------------------------------------------------------

describe("useDraftSecretDetection detection", () => {
  test("match surfaces, dismiss hides, deletion resets", async () => {
    setDraft(`here is ${SYNTHETIC_PROJECT_KEY}`);
    const { result } = renderDetection();

    expect(result.current.matches).toHaveLength(1);
    expect(result.current.matches[0]?.value).toBe(SYNTHETIC_PROJECT_KEY);
    expect(result.current.dismissed).toBe(false);

    act(() => {
      result.current.dismiss();
    });
    expect(result.current.dismissed).toBe(true);

    // Deleting the key removes the match and resets dismissal.
    setDraft("no secrets here anymore");
    await waitFor(() => {
      expect(result.current.matches).toEqual([]);
    });
    expect(result.current.dismissed).toBe(false);
  });

  test("a newly flagged value re-surfaces a dismissed notice", async () => {
    setDraft(`first ${SYNTHETIC_PROJECT_KEY}`);
    const { result } = renderDetection();
    act(() => {
      result.current.dismiss();
    });
    expect(result.current.dismissed).toBe(true);

    setDraft(`first ${SYNTHETIC_PROJECT_KEY} then ${SYNTHETIC_GITHUB_TOKEN}`);
    await waitFor(() => {
      expect(result.current.matches).toHaveLength(2);
    });
    expect(result.current.dismissed).toBe(false);
  });

  test("dismissal resets when the conversation changes", () => {
    setDraft(`here is ${SYNTHETIC_PROJECT_KEY}`);
    const { result, rerender } = renderDetection("conv-1");
    act(() => {
      result.current.dismiss();
    });
    expect(result.current.dismissed).toBe(true);

    rerender({ conversationId: "conv-2" });
    expect(result.current.dismissed).toBe(false);
  });

  test("conversation switch clears stale matches synchronously — even dismissed ones", () => {
    setDraft(`here is ${SYNTHETIC_PROJECT_KEY}`);
    const { result, rerender } = renderDetection("conv-1", NEVER_ELAPSES_MS);
    expect(result.current.matches).toHaveLength(1);
    act(() => {
      result.current.dismiss();
    });
    act(() => {
      result.current.checkBeforeSend(`send ${SYNTHETIC_PROJECT_KEY}`);
    });
    expect(result.current.sendBlocked).toBe(true);

    // The draft swap lands via a post-render store effect, so at switch time
    // the composer still holds conversation A's draft. The stale match (and
    // its masked preview, un-hidden by the dismissal reset) must already be
    // gone — no debounce-window flash over conversation B's composer.
    rerender({ conversationId: "conv-2" });
    expect(result.current.matches).toEqual([]);
    expect(result.current.dismissed).toBe(false);
    expect(result.current.sendBlocked).toBe(false);
  });

  test("a restored draft with a secret warns immediately after a switch", () => {
    setDraft(`conversation A: ${SYNTHETIC_PROJECT_KEY}`);
    const { result, rerender } = renderDetection("conv-1", NEVER_ELAPSES_MS);
    expect(result.current.matches).toHaveLength(1);

    rerender({ conversationId: "conv-2" });
    expect(result.current.matches).toEqual([]);

    // The session store restores conversation B's saved draft after the
    // switch commit; its secret surfaces without waiting out the debounce.
    setDraft(`restored draft: ${SYNTHETIC_GITHUB_TOKEN}`);
    expect(result.current.matches).toHaveLength(1);
    expect(result.current.matches[0]?.value).toBe(SYNTHETIC_GITHUB_TOKEN);
    expect(result.current.dismissed).toBe(false);

    // The immediate scan is single-use — the next input change is a
    // keystroke again and waits out the (never-elapsing) debounce.
    setDraft(
      `restored draft: ${SYNTHETIC_GITHUB_TOKEN} plus ${SYNTHETIC_PROJECT_KEY}`,
    );
    expect(result.current.matches).toHaveLength(1);
  });

  test("an identical restored draft with the same secret warns immediately after a switch", () => {
    // The same pasted key is drafted in both conversations, so the restored
    // draft is byte-identical to the outgoing one.
    const sharedDraft = `here is ${SYNTHETIC_PROJECT_KEY}`;
    setDraft(sharedDraft);
    const { result, rerender } = renderDetection("conv-1", NEVER_ELAPSES_MS);
    expect(result.current.matches).toHaveLength(1);

    rerender({ conversationId: "conv-2" });
    expect(result.current.matches).toEqual([]);

    // Conversation B's restored draft equals conversation A's byte-for-byte,
    // so the composer input is unchanged across the swap and the
    // subscription's identity guard would skip the scan. The armed
    // immediate-scan must still run so the repeated secret warns without a
    // keystroke or a debounce wait.
    setDraft(sharedDraft);
    expect(result.current.matches).toHaveLength(1);
    expect(result.current.matches[0]?.value).toBe(SYNTHETIC_PROJECT_KEY);
    expect(result.current.dismissed).toBe(false);

    // The immediate scan is single-use — an unchanged draft afterward is an
    // ordinary keystroke path again and early-outs (no re-scan needed), while
    // an actual edit waits out the (never-elapsing) debounce.
    setDraft(`${sharedDraft} plus ${SYNTHETIC_GITHUB_TOKEN}`);
    expect(result.current.matches).toHaveLength(1);
  });

  test("a switch to an empty draft still clears matches (identity fix does not resurrect)", async () => {
    setDraft(`conversation A: ${SYNTHETIC_PROJECT_KEY}`);
    const { result, rerender } = renderDetection("conv-1", 0);
    expect(result.current.matches).toHaveLength(1);

    rerender({ conversationId: "conv-2" });
    expect(result.current.matches).toEqual([]);

    // Conversation B has no saved draft: the switch swap clears the composer.
    setDraft("");
    await waitFor(() => {
      expect(result.current.matches).toEqual([]);
    });
    expect(result.current.dismissed).toBe(false);
  });

  test("scanning waits out the debounce between keystrokes", async () => {
    const { result } = renderDetection();
    expect(result.current.matches).toEqual([]);

    setDraft(`typed later: ${SYNTHETIC_PROJECT_KEY}`);
    // Debounced: not scanned synchronously on the keystroke.
    expect(result.current.matches).toEqual([]);
    await waitFor(() => {
      expect(result.current.matches).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Hook — pre-send gate state (invoked by useComposerSubmit's beforeSend)
// ---------------------------------------------------------------------------

describe("useDraftSecretDetection checkBeforeSend", () => {
  test("blocks a send containing a secret and sets sendBlocked", () => {
    const { result } = renderDetection();

    let allowed = true;
    act(() => {
      allowed = result.current.checkBeforeSend(`send ${SYNTHETIC_PROJECT_KEY}`);
    });
    expect(allowed).toBe(false);
    expect(result.current.sendBlocked).toBe(true);
    expect(result.current.matches).toHaveLength(1);
  });

  test("allowOnce arms a single-use bypass for the blocked content", () => {
    const { result } = renderDetection();

    act(() => {
      result.current.checkBeforeSend(`send ${SYNTHETIC_PROJECT_KEY}`);
    });
    expect(result.current.sendBlocked).toBe(true);

    act(() => {
      result.current.allowOnce();
    });
    let allowed = false;
    act(() => {
      allowed = result.current.checkBeforeSend(`send ${SYNTHETIC_PROJECT_KEY}`);
    });
    expect(allowed).toBe(true);
    expect(result.current.sendBlocked).toBe(false);

    // Single-use: the identical content blocks again without a fresh arm.
    act(() => {
      allowed = result.current.checkBeforeSend(`send ${SYNTHETIC_PROJECT_KEY}`);
    });
    expect(allowed).toBe(false);
    expect(result.current.sendBlocked).toBe(true);
  });

  test("the bypass is content-bound: different content is scanned and re-blocked", () => {
    const { result } = renderDetection();

    // Block on key A, then approve via Send anyway.
    act(() => {
      result.current.checkBeforeSend(`send ${SYNTHETIC_PROJECT_KEY}`);
    });
    expect(result.current.sendBlocked).toBe(true);
    act(() => {
      result.current.allowOnce();
    });

    // The outgoing content changed to carry key B — the armed bypass must
    // NOT apply; the synchronous scan runs and blocks key B.
    let allowed = true;
    act(() => {
      allowed = result.current.checkBeforeSend(
        `send ${SYNTHETIC_GITHUB_TOKEN}`,
      );
    });
    expect(allowed).toBe(false);
    expect(result.current.sendBlocked).toBe(true);
    expect(result.current.matches[0]?.value).toBe(SYNTHETIC_GITHUB_TOKEN);
  });

  test("allowOnce without a recorded block arms nothing", () => {
    const { result } = renderDetection();

    act(() => {
      result.current.allowOnce();
    });
    let allowed = true;
    act(() => {
      allowed = result.current.checkBeforeSend(`send ${SYNTHETIC_PROJECT_KEY}`);
    });
    expect(allowed).toBe(false);
    expect(result.current.sendBlocked).toBe(true);
  });

  test("a draft edit after a block clears sendBlocked and disarms the bypass", () => {
    // Never-elapsing debounce: only the synchronous subscription runs, so
    // the resets below prove the edit itself cleared the state.
    const { result } = renderDetection("conv-1", NEVER_ELAPSES_MS);
    act(() => {
      result.current.checkBeforeSend(`send ${SYNTHETIC_PROJECT_KEY}`);
    });
    expect(result.current.sendBlocked).toBe(true);
    act(() => {
      result.current.allowOnce();
    });

    // The edit clears the blocked state immediately — the notice drops back
    // to the passive warning — without waiting for the debounced re-scan.
    setDraft(`edited to ${SYNTHETIC_GITHUB_TOKEN}`);
    expect(result.current.sendBlocked).toBe(false);

    // And the edited content gets a fresh scan + fresh block, even when it
    // is exactly what a stale bypass might have been armed for.
    let allowed = true;
    act(() => {
      allowed = result.current.checkBeforeSend(
        `edited to ${SYNTHETIC_GITHUB_TOKEN}`,
      );
    });
    expect(allowed).toBe(false);
    expect(result.current.sendBlocked).toBe(true);
  });

  test("dismissing a blocked notice clears sendBlocked but keeps dismissal", () => {
    setDraft(`here is ${SYNTHETIC_PROJECT_KEY}`);
    const { result } = renderDetection();
    act(() => {
      result.current.checkBeforeSend(`here is ${SYNTHETIC_PROJECT_KEY}`);
    });
    expect(result.current.sendBlocked).toBe(true);

    act(() => {
      result.current.dismiss();
    });
    expect(result.current.sendBlocked).toBe(false);
    expect(result.current.dismissed).toBe(true);
  });

  test("a blocked send after dismissal re-blocks (dismissal never bypasses)", () => {
    setDraft(`here is ${SYNTHETIC_PROJECT_KEY}`);
    const { result } = renderDetection();
    act(() => {
      result.current.dismiss();
    });
    expect(result.current.dismissed).toBe(true);

    let allowed = true;
    act(() => {
      allowed = result.current.checkBeforeSend(
        `here is ${SYNTHETIC_PROJECT_KEY}`,
      );
    });
    expect(allowed).toBe(false);
    expect(result.current.sendBlocked).toBe(true);
  });

  test("passes clean text and clears sendBlocked", () => {
    const { result } = renderDetection();
    act(() => {
      result.current.checkBeforeSend(`send ${SYNTHETIC_PROJECT_KEY}`);
    });
    expect(result.current.sendBlocked).toBe(true);

    let allowed = false;
    act(() => {
      allowed = result.current.checkBeforeSend("all clear now");
    });
    expect(allowed).toBe(true);
    expect(result.current.sendBlocked).toBe(false);
  });
});
