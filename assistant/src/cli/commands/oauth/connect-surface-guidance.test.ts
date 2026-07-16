import { describe, expect, test } from "bun:test";

import {
  buildOAuthConnectSurfaceRedirect,
  isModelSpawnedConversationShell,
  oauthConnectSurfaceHint,
} from "./connect-surface-guidance.js";

describe("OAuth connect surface guidance", () => {
  test("builds the oauth_connect next action payload", () => {
    expect(buildOAuthConnectSurfaceRedirect("google")).toEqual({
      ok: false,
      code: "use_oauth_connect_surface",
      provider: "google",
      hint: oauthConnectSurfaceHint("google"),
      nextAction: {
        type: "ui_show",
        surfaceType: "oauth_connect",
        data: { providerKey: "google" },
      },
    });
  });

  test("detects model-spawned conversation shells", () => {
    expect(
      isModelSpawnedConversationShell({ __CONVERSATION_ID: "conv-123" }),
    ).toBe(true);
    expect(isModelSpawnedConversationShell({ __CONVERSATION_ID: "   " })).toBe(
      false,
    );
    expect(isModelSpawnedConversationShell({})).toBe(false);
  });

  test("hint tells the model not to paste OAuth URLs", () => {
    const hint = oauthConnectSurfaceHint("google");
    expect(hint).toContain('surface_type "oauth_connect"');
    expect(hint).toContain('data.providerKey "google"');
    expect(hint).toContain("paste an OAuth URL");
  });
});
