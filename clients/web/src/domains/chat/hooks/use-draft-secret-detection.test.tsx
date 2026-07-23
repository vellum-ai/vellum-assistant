/**
 * Tests for the draft secret-detection hook and its pure scan policy.
 *
 * Uses the real composer and assistant-feature-flag stores (reset between
 * tests) so the hook's store subscription, flag gating, and dismissal
 * lifecycle are exercised end to end. All tokens are synthetic values
 * invented for these tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { useComposerStore } from "@/domains/chat/composer-store";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

import {
  SECRET_SCAN_MIN_DRAFT_LENGTH,
  scanDraftForSecrets,
  useDraftSecretDetection,
} from "./use-draft-secret-detection";

// Synthetic lookalike tokens — random strings matching detector shapes.
const SYNTHETIC_PROJECT_KEY =
  "sk-proj-Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3A";
const SYNTHETIC_GITHUB_TOKEN = "ghp_Zx9Wv8Ut7Sr6Qp5On4Ml3Kj2Ih1Gf0EdCbA9";

function seedFlags(flags: {
  composerSecretGuard: boolean;
  hasHydrated: boolean;
}) {
  useAssistantFeatureFlagStore.setState(flags);
}

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
  seedFlags({ composerSecretGuard: false, hasHydrated: false });
  useComposerStore.getState().setInput("");
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Pure scan policy
// ---------------------------------------------------------------------------

describe("scanDraftForSecrets", () => {
  test("returns nothing when disabled, regardless of content", () => {
    expect(
      scanDraftForSecrets(`deploy with ${SYNTHETIC_PROJECT_KEY}`, false),
    ).toEqual([]);
  });

  test("skips drafts shorter than the minimum scan length", () => {
    const short = "a".repeat(SECRET_SCAN_MIN_DRAFT_LENGTH - 1);
    expect(scanDraftForSecrets(short, true)).toEqual([]);
  });

  test("detects a token in a long-enough enabled draft", () => {
    const matches = scanDraftForSecrets(
      `here is ${SYNTHETIC_PROJECT_KEY} for you`,
      true,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.value).toBe(SYNTHETIC_PROJECT_KEY);
  });
});

// ---------------------------------------------------------------------------
// Hook — flag gating
// ---------------------------------------------------------------------------

describe("useDraftSecretDetection flag gating", () => {
  test("flag off: no matches even with a key in the draft", () => {
    seedFlags({ composerSecretGuard: false, hasHydrated: true });
    setDraft(`deploy with ${SYNTHETIC_PROJECT_KEY}`);
    const { result } = renderDetection();
    expect(result.current.matches).toEqual([]);
    expect(result.current.dismissed).toBe(false);
    expect(result.current.sendBlocked).toBe(false);
  });

  test("flag on but store not hydrated: inert", () => {
    seedFlags({ composerSecretGuard: true, hasHydrated: false });
    setDraft(`deploy with ${SYNTHETIC_PROJECT_KEY}`);
    const { result } = renderDetection();
    expect(result.current.matches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hook — detection + dismissal lifecycle
// ---------------------------------------------------------------------------

describe("useDraftSecretDetection detection", () => {
  test("flag on: match surfaces, dismiss hides, deletion resets", async () => {
    seedFlags({ composerSecretGuard: true, hasHydrated: true });
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
    seedFlags({ composerSecretGuard: true, hasHydrated: true });
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
    seedFlags({ composerSecretGuard: true, hasHydrated: true });
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
    seedFlags({ composerSecretGuard: true, hasHydrated: true });
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
    seedFlags({ composerSecretGuard: true, hasHydrated: true });
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

  test("scanning waits out the debounce between keystrokes", async () => {
    seedFlags({ composerSecretGuard: true, hasHydrated: true });
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
    seedFlags({ composerSecretGuard: true, hasHydrated: true });
    const { result } = renderDetection();

    let allowed = true;
    act(() => {
      allowed = result.current.checkBeforeSend(`send ${SYNTHETIC_PROJECT_KEY}`);
    });
    expect(allowed).toBe(false);
    expect(result.current.sendBlocked).toBe(true);
    expect(result.current.matches).toHaveLength(1);
  });

  test("allowOnce arms a single-use bypass", () => {
    seedFlags({ composerSecretGuard: true, hasHydrated: true });
    const { result } = renderDetection();

    act(() => {
      result.current.allowOnce();
    });
    let allowed = false;
    act(() => {
      allowed = result.current.checkBeforeSend(`send ${SYNTHETIC_PROJECT_KEY}`);
    });
    expect(allowed).toBe(true);
    expect(result.current.sendBlocked).toBe(false);

    act(() => {
      allowed = result.current.checkBeforeSend(`send ${SYNTHETIC_PROJECT_KEY}`);
    });
    expect(allowed).toBe(false);
    expect(result.current.sendBlocked).toBe(true);
  });

  test("a draft edit invalidates an armed allowOnce bypass", () => {
    seedFlags({ composerSecretGuard: true, hasHydrated: true });
    // Never-elapsing debounce: only the synchronous subscription runs, so a
    // block below proves the edit itself disarmed the bypass.
    const { result } = renderDetection("conv-1", NEVER_ELAPSES_MS);
    act(() => {
      result.current.allowOnce();
    });

    setDraft(`edited to ${SYNTHETIC_GITHUB_TOKEN}`);
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
    seedFlags({ composerSecretGuard: true, hasHydrated: true });
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
    seedFlags({ composerSecretGuard: true, hasHydrated: true });
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
    seedFlags({ composerSecretGuard: true, hasHydrated: true });
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

  test("passes everything while the flag is off", () => {
    seedFlags({ composerSecretGuard: false, hasHydrated: true });
    const { result } = renderDetection();
    let allowed = false;
    act(() => {
      allowed = result.current.checkBeforeSend(`send ${SYNTHETIC_PROJECT_KEY}`);
    });
    expect(allowed).toBe(true);
    expect(result.current.sendBlocked).toBe(false);
  });
});
