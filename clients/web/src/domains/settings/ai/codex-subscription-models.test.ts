import { describe, expect, test } from "bun:test";

import { CODEX_SUBSCRIPTION_MODEL_IDS } from "@/domains/settings/ai/codex-subscription-models";
// The daemon's allowlist is the source of truth for what the Codex endpoint
// serves; the web copy exists because the client cannot import daemon source
// at runtime. This parity check makes drift a test failure instead of a
// silently wrong picker.
import { CODEX_SUBSCRIPTION_MODEL_IDS as DAEMON_SET } from "../../../../../../assistant/src/providers/openai/codex-models";

describe("codex subscription model set", () => {
  test("matches the daemon allowlist exactly", () => {
    expect([...CODEX_SUBSCRIPTION_MODEL_IDS].sort()).toEqual(
      [...DAEMON_SET].sort(),
    );
  });
});
