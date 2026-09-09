/**
 * Tests for `useImageAttachmentsAllowed`, the shared vision gate every
 * attachment surface filters images through. Both dependencies are mocked so
 * this file asserts the composition alone, not the version gate's version math
 * or the profile hook's config resolution, which have their own suites.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import type { ActiveProfileModel } from "@/domains/chat/hooks/use-active-profile-model";

let profileModel: ActiveProfileModel | null = null;
let profileResolved = true;
let gateActive = false;

mock.module("@/domains/chat/hooks/use-active-profile-model", () => ({
  useActiveProfileModelState: () => ({
    model: profileModel,
    resolved: profileResolved,
  }),
}));

mock.module("@/lib/backwards-compat/vision-attachment-gate", () => ({
  useVisionAttachmentGate: () => gateActive,
}));

const { useImageAttachmentsAllowed } =
  await import("@/domains/chat/hooks/use-image-attachments-allowed");

function check(): boolean | null {
  const { result } = renderHook(() =>
    useImageAttachmentsAllowed("assistant-1", "conv-1"),
  );
  return result.current;
}

afterEach(() => {
  cleanup();
  profileModel = null;
  profileResolved = true;
  gateActive = false;
});

describe("useImageAttachmentsAllowed", () => {
  test("allows images on an assistant that captions them server-side", () => {
    // GIVEN an assistant new enough that the gate is inactive
    gateActive = false;
    profileModel = { provider: "openai", model: "o-no-vision" };

    // WHEN the model has no vision support at all
    // THEN images are still allowed, because the image-fallback plugin
    // handles them
    expect(check()).toBe(true);
  });

  test("allows images with the gate inactive before any profile resolves", () => {
    // Nothing about the model can change the answer once the gate is out of
    // the way, so there is nothing to wait for.
    gateActive = false;
    profileResolved = false;
    expect(check()).toBe(true);
  });

  test("allows images while the gate is active and the model sees them", () => {
    gateActive = true;
    profileModel = {
      provider: "anthropic",
      model: "claude",
      supportsVision: true,
    };
    expect(check()).toBe(true);
  });

  test("turns images away while the gate is active and the model cannot see", () => {
    gateActive = true;
    profileModel = {
      provider: "openai",
      model: "text-only",
      supportsVision: false,
    };
    expect(check()).toBe(false);
  });

  test("withholds an answer while the gate is active and the profile is unresolved", () => {
    // A config or conversation row still loading is not evidence either way,
    // and nothing revalidates an image once it is staged, so the caller is
    // told to wait rather than handed a guess.
    gateActive = true;
    profileResolved = false;
    profileModel = null;
    expect(check()).toBeNull();
  });

  test("allows images once resolved with no model to speak of", () => {
    // A resolved profile that names no provider/model is a settled absence,
    // not a loading read, so the gate opens rather than blocking an
    // attachment the model may well take.
    gateActive = true;
    profileModel = null;
    expect(check()).toBe(true);
  });

  test("allows images for a profile that declares no vision capability", () => {
    gateActive = true;
    profileModel = { provider: "custom", model: "unknown" };
    expect(check()).toBe(true);
  });
});
