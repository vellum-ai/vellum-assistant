import { describe, expect, mock, test } from "bun:test";

import {
  createTestHandlerContext,
  noopLogger,
} from "./handlers/handler-test-helpers.js";

// ── Mocks (before any handler imports) ──────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () => noopLogger,
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  broadcastClientSettingsUpdate,
  handleVoiceConfigUpdate,
} from "../daemon/handlers/config-voice.js";

// ── Tests ───────────────────────────────────────────────────────────────────

describe("broadcastClientSettingsUpdate", () => {
  test("sends client_settings_update with correct shape", () => {
    const { ctx, sent } = createTestHandlerContext();

    broadcastClientSettingsUpdate("activationKey", "fn", ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "client_settings_update",
      key: "activationKey",
      value: "fn",
    });
  });

  test("works with arbitrary key/value pairs", () => {
    const { ctx, sent } = createTestHandlerContext();

    broadcastClientSettingsUpdate("theme", "dark", ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("client_settings_update");
    expect(sent[0].key).toBe("theme");
    expect(sent[0].value).toBe("dark");
  });
});

describe("handleVoiceConfigUpdate", () => {
  test("valid 'fn' → broadcasts client_settings_update", () => {
    const { ctx, sent } = createTestHandlerContext();

    handleVoiceConfigUpdate(
      { type: "voice_config_update", activationKey: "fn" },
      ctx,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("client_settings_update");
    expect(sent[0].key).toBe("activationKey");
    expect(sent[0].value).toBe("fn");
  });

  test("natural language 'globe' → broadcasts with value 'fn'", () => {
    const { ctx, sent } = createTestHandlerContext();

    handleVoiceConfigUpdate(
      { type: "voice_config_update", activationKey: "globe" },
      ctx,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].value).toBe("fn");
  });

  test("PTTActivator JSON → broadcasts with JSON string value", () => {
    const json = '{"kind":"modifierOnly","modifierFlags":96}';
    const { ctx, sent } = createTestHandlerContext();

    handleVoiceConfigUpdate(
      { type: "voice_config_update", activationKey: json },
      ctx,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("client_settings_update");
    expect(sent[0].value).toBe(json);
  });

  test("invalid key → no broadcast", () => {
    const { ctx, sent } = createTestHandlerContext();

    handleVoiceConfigUpdate(
      { type: "voice_config_update", activationKey: "not_a_key" },
      ctx,
    );

    expect(sent).toHaveLength(0);
  });

  test("empty string → no broadcast", () => {
    const { ctx, sent } = createTestHandlerContext();

    handleVoiceConfigUpdate(
      { type: "voice_config_update", activationKey: "" },
      ctx,
    );

    expect(sent).toHaveLength(0);
  });
});
