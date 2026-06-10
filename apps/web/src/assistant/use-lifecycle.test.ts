/**
 * Tests the proactive wrong-org guard that the lifecycle hook applies to
 * the per-org platform selection before handing it to the service. A
 * known cross-org selection resolves to null up front; matching-org and
 * not-yet-resolved (unknown) ids pass through so the 404 net in
 * `lifecycle-service.ts` still covers ids the client can't see.
 */

import { describe, expect, test } from "bun:test";

import { resolveSelectedPlatformAssistantId } from "@/assistant/use-lifecycle";
import type { ResolvedAssistant } from "@/stores/resolved-assistants-store";

const ORG_A = "org-a";
const ORG_B = "org-b";

function platformAssistant(
  id: string,
  organizationId?: string,
): ResolvedAssistant {
  return {
    id,
    isLocal: false,
    isPlatformHosted: true,
    organizationId,
  };
}

describe("resolveSelectedPlatformAssistantId", () => {
  test("drops a selection whose entry belongs to another org", () => {
    const assistants = [platformAssistant("asst-1", ORG_B)];
    expect(
      resolveSelectedPlatformAssistantId("asst-1", assistants, ORG_A),
    ).toBeNull();
  });

  test("passes through a selection whose entry matches the active org", () => {
    const assistants = [platformAssistant("asst-1", ORG_A)];
    expect(
      resolveSelectedPlatformAssistantId("asst-1", assistants, ORG_A),
    ).toBe("asst-1");
  });

  test("passes through an id with no resolved entry (404 net applies)", () => {
    const assistants = [platformAssistant("asst-other", ORG_A)];
    expect(
      resolveSelectedPlatformAssistantId("asst-unknown", assistants, ORG_A),
    ).toBe("asst-unknown");
  });

  test("passes through a legacy entry with no org (undefined)", () => {
    const assistants = [platformAssistant("asst-1", undefined)];
    expect(
      resolveSelectedPlatformAssistantId("asst-1", assistants, ORG_A),
    ).toBe("asst-1");
  });

  test("returns null when there is no candidate", () => {
    expect(resolveSelectedPlatformAssistantId(null, [], ORG_A)).toBeNull();
  });
});
