/**
 * Tests for the pure `avatar_changed` mapper and its no-op predicate. Nothing
 * here touches the filesystem: states are literals, and every payload the
 * mapper produces is checked against the synced wire schema.
 */
import { describe, expect, test } from "bun:test";

import { avatarChangedTelemetryEventSchema } from "../../telemetry/telemetry-wire.generated.js";
import {
  avatarChangedFields,
  isSameAvatar,
} from "../avatar-changed-telemetry.js";
import { type AvatarState, NONE_AVATAR_STATE } from "../avatar-manifest.js";

const TRAITS = { bodyShape: "blob", eyeStyle: "curious", color: "green" };

const CHARACTER: AvatarState = {
  kind: "character",
  traits: TRAITS,
  source: "builder",
  image: null,
  accent: { hex: "#4caf50", source: "palette" },
};

const UPLOADED: AvatarState = {
  kind: "image",
  traits: null,
  source: "upload",
  image: { updatedAt: "2026-01-01T00:00:00.000Z", etag: "etag-1" },
  accent: { hex: "#c81e1e", source: "derived" },
};

/** The same PNG written again: fresh metadata, everything else equal. */
const UPLOADED_REWRITTEN: AvatarState = {
  ...UPLOADED,
  image: { updatedAt: "2026-01-02T00:00:00.000Z", etag: "etag-2" },
};

/** An image manifest derived from legacy files: it names no source and no accent. */
const UPLOADED_LEGACY: AvatarState = {
  ...UPLOADED,
  source: null,
  accent: null,
};

const CUSTOM_ACCENT = { hex: "#123456", source: "custom" } as const;

function parseOnTheWire(fields: ReturnType<typeof avatarChangedFields>) {
  return avatarChangedTelemetryEventSchema.safeParse({
    type: "avatar_changed",
    daemon_event_id: "evt-avatar-changed-001",
    recorded_at: 1_767_225_600_000,
    assistant_version: "1.2.3",
    ...fields,
  });
}

describe("avatarChangedFields", () => {
  test("a character carries its trait ids and palette accent", () => {
    const fields = avatarChangedFields("set_character", UPLOADED, CHARACTER);
    expect(fields).toStrictEqual({
      action: "set_character",
      kind: "character",
      previous_kind: "image",
      body_shape: "blob",
      eye_style: "curious",
      color: "green",
      accent_hex: "#4caf50",
      accent_source: "palette",
    });
  });

  test("an image carries its derived accent and no trait keys", () => {
    const fields = avatarChangedFields("upload_image", CHARACTER, UPLOADED);
    expect(fields).toStrictEqual({
      action: "upload_image",
      kind: "image",
      previous_kind: "character",
      accent_hex: "#c81e1e",
      accent_source: "derived",
    });
  });

  test("a cleared avatar carries only the action and the two kinds", () => {
    const fields = avatarChangedFields("clear", UPLOADED, NONE_AVATAR_STATE);
    expect(fields).toStrictEqual({
      action: "clear",
      kind: "none",
      previous_kind: "image",
    });
  });

  test("a first set reports a previous kind of none", () => {
    expect(
      avatarChangedFields("set_character", NONE_AVATAR_STATE, CHARACTER)
        .previous_kind,
    ).toBe("none");
  });

  test("an upper-case palette hex is emitted lower case", () => {
    const fields = avatarChangedFields("set_character", NONE_AVATAR_STATE, {
      ...CHARACTER,
      accent: { hex: "#4C9B50", source: "palette" },
    });
    expect(fields.accent_hex).toBe("#4c9b50");
  });

  test("the client OS rides along only when it is non-empty", () => {
    const withOs = avatarChangedFields(
      "generate_image",
      NONE_AVATAR_STATE,
      UPLOADED,
      "macos",
    );
    expect(withOs.client_os).toBe("macos");

    const emptyOs = avatarChangedFields(
      "generate_image",
      NONE_AVATAR_STATE,
      UPLOADED,
      "",
    );
    expect(emptyOs).not.toHaveProperty("client_os");
  });

  test("every payload parses under the synced wire schema", () => {
    const payloads = [
      avatarChangedFields("set_character", NONE_AVATAR_STATE, CHARACTER),
      avatarChangedFields("upload_image", CHARACTER, UPLOADED, "web"),
      avatarChangedFields("generate_image", NONE_AVATAR_STATE, UPLOADED),
      avatarChangedFields("set_accent", UPLOADED, {
        ...UPLOADED,
        accent: CUSTOM_ACCENT,
      }),
      avatarChangedFields("clear", CHARACTER, NONE_AVATAR_STATE),
    ];
    for (const payload of payloads) {
      const parsed = parseOnTheWire(payload);
      expect(parsed.success).toBe(true);
    }
  });
});

describe("isSameAvatar", () => {
  test("a character re-set with the same traits is the same", () => {
    expect(isSameAvatar(CHARACTER, { ...CHARACTER })).toBe(true);
  });

  test("a character with one trait changed is not", () => {
    expect(
      isSameAvatar(CHARACTER, {
        ...CHARACTER,
        traits: { ...TRAITS, color: "blue" },
      }),
    ).toBe(false);
  });

  test("the same traits under a custom rather than palette accent is not", () => {
    expect(
      isSameAvatar(CHARACTER, {
        ...CHARACTER,
        accent: { hex: "#4caf50", source: "custom" },
      }),
    ).toBe(false);
  });

  test("a character whose accent was never recorded is the same under its palette accent", () => {
    expect(isSameAvatar({ ...CHARACTER, accent: null }, CHARACTER)).toBe(true);
  });

  test("an image rewritten from the same bytes and source is the same", () => {
    expect(isSameAvatar(UPLOADED, UPLOADED_REWRITTEN)).toBe(true);
  });

  test("an image whose bytes changed is not, even when every manifest field matches", () => {
    expect(isSameAvatar(UPLOADED, UPLOADED_REWRITTEN, true)).toBe(false);
  });

  test("the same bytes from a different source is not", () => {
    expect(isSameAvatar(UPLOADED, { ...UPLOADED, source: "ai" })).toBe(false);
  });

  test("the same bytes under a different accent is not", () => {
    expect(
      isSameAvatar(UPLOADED, {
        ...UPLOADED,
        accent: { hex: "#c81e1e", source: "custom" },
      }),
    ).toBe(false);
  });

  test("a legacy-derived image re-set from the same bytes is the same, whatever the source", () => {
    expect(isSameAvatar(UPLOADED_LEGACY, UPLOADED)).toBe(true);
    expect(isSameAvatar(UPLOADED_LEGACY, { ...UPLOADED, source: "ai" })).toBe(
      true,
    );
  });

  test("a custom accent over one that was never recorded is not", () => {
    expect(
      isSameAvatar(UPLOADED_LEGACY, { ...UPLOADED, accent: CUSTOM_ACCENT }),
    ).toBe(false);
  });

  test("none is always the same as none", () => {
    expect(isSameAvatar(NONE_AVATAR_STATE, NONE_AVATAR_STATE)).toBe(true);
    expect(
      isSameAvatar(NONE_AVATAR_STATE, { ...NONE_AVATAR_STATE }, true),
    ).toBe(true);
  });

  test("none is never the same as an avatar", () => {
    expect(isSameAvatar(NONE_AVATAR_STATE, CHARACTER)).toBe(false);
    expect(isSameAvatar(NONE_AVATAR_STATE, UPLOADED)).toBe(false);
    expect(isSameAvatar(UPLOADED, NONE_AVATAR_STATE)).toBe(false);
  });
});
