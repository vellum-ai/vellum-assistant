import { beforeEach, describe, expect, mock, test } from "bun:test";

import { markAssistantOnboarded } from "@/domains/onboarding/onboarded-assistant-record";
import { NEW_ASSISTANT_PARAM } from "@/domains/onboarding/onboarding-destination";
import { onboardingCompletedMiddleware } from "@/lib/onboarding-middleware";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { writeSelectedAssistantId } from "@/assistant/selected-assistant-storage";
import { routes } from "@/utils/routes";

function makeRequest(path: string): Request {
  return new Request(`https://example.com${path}`);
}

describe("onboardingCompletedMiddleware", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useResolvedAssistantsStore.setState({
      assistants: [],
      assistantsHydrated: false,
    });
  });

  test("allows preview mode to bypass the guard", async () => {
    const next = mock(async () => "ok");

    const result = await onboardingCompletedMiddleware(
      {
        request: makeRequest(`${routes.onboarding.privacy}?preview=true`),
      } as Parameters<typeof onboardingCompletedMiddleware>[0],
      next,
    );

    expect(result).toBe("ok");
    expect(next).toHaveBeenCalled();
  });

  test("does not allow preview bypass on hatching route", async () => {
    const next = mock(async () => "ok");

    await expect(
      onboardingCompletedMiddleware(
        {
          request: makeRequest(`${routes.onboarding.hatching}?preview=true`),
        } as Parameters<typeof onboardingCompletedMiddleware>[0],
        next,
      ),
    ).rejects.toThrow();
    expect(next).not.toHaveBeenCalled();
  });

  // The guard decides on the URL's QUERY as well as its path: the new-assistant
  // marker rides there. Resolving on the bare pathname read every provisioning
  // walk as an unmarked re-entry and bounced it to `/assistant`, which sends a
  // local client back to the chooser it started from.
  describe("new-assistant marker", () => {
    const WEEK_OLD = () =>
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const row = (id: string, hatchedAt: string) => ({
      id,
      hatchedAt,
      isLocal: true,
      isPlatformHosted: false,
      isPaired: false,
    });

    beforeEach(() => {
      // An onboarded SELECTED assistant is what arms the privacy bounce.
      useResolvedAssistantsStore.setState({
        assistants: [row("asst-old", WEEK_OLD())],
        assistantsHydrated: true,
      });
      writeSelectedAssistantId("asst-old");
    });

    test("bounces an unmarked privacy entry", async () => {
      const next = mock(async () => "ok");

      await expect(
        onboardingCompletedMiddleware(
          {
            request: makeRequest(`${routes.onboarding.privacy}?hosting=local`),
          } as Parameters<typeof onboardingCompletedMiddleware>[0],
          next,
        ),
      ).rejects.toThrow();
      expect(next).not.toHaveBeenCalled();
    });

    // Scoping, at the layer that actually runs the redirect: an established
    // sibling must not answer for the assistant the user just selected.
    test("does not bounce when the selected assistant is unonboarded", async () => {
      useResolvedAssistantsStore.setState({
        assistants: [
          row("asst-old", WEEK_OLD()),
          row("asst-new", new Date().toISOString()),
        ],
        assistantsHydrated: true,
      });
      writeSelectedAssistantId("asst-new");
      const next = mock(async () => "ok");

      const result = await onboardingCompletedMiddleware(
        {
          request: makeRequest(`${routes.onboarding.privacy}?hosting=local`),
        } as Parameters<typeof onboardingCompletedMiddleware>[0],
        next,
      );

      expect(result).toBe("ok");
      expect(next).toHaveBeenCalled();
    });

    // The stamp is read live, not cached on the assistant row: a completion
    // has to take effect without waiting for the assistant list to be rebuilt
    // (and reaches other tabs the same way).
    test("a fresh stamp arms the bounce with no store refresh", async () => {
      useResolvedAssistantsStore.setState({
        assistants: [row("asst-new", new Date().toISOString())],
        assistantsHydrated: true,
      });
      writeSelectedAssistantId("asst-new");
      const request = () =>
        ({
          request: makeRequest(`${routes.onboarding.privacy}?hosting=local`),
        }) as Parameters<typeof onboardingCompletedMiddleware>[0];

      expect(
        await onboardingCompletedMiddleware(request(), async () => "ok"),
      ).toBe("ok");

      markAssistantOnboarded("asst-new");

      await expect(
        onboardingCompletedMiddleware(request(), async () => "ok"),
      ).rejects.toThrow();
    });

    test("lets a marked provisioning walk through", async () => {
      const next = mock(async () => "ok");

      const result = await onboardingCompletedMiddleware(
        {
          request: makeRequest(
            `${routes.onboarding.privacy}?hosting=local&${NEW_ASSISTANT_PARAM}=1`,
          ),
        } as Parameters<typeof onboardingCompletedMiddleware>[0],
        next,
      );

      expect(result).toBe("ok");
      expect(next).toHaveBeenCalled();
    });
  });

  test("allows the local research flow after hatch when onboarding is not complete", async () => {
    localStorage.setItem(
      "vellum:local:lockfile",
      JSON.stringify({
        assistants: [
          {
            assistantId: "asst-local-1",
            cloud: "local",
            runtimeUrl: "http://localhost:5173",
          },
        ],
        activeAssistant: "asst-local-1",
      }),
    );
    const next = mock(async () => "ok");

    const result = await onboardingCompletedMiddleware(
      { request: makeRequest(routes.onboarding.research) } as Parameters<
        typeof onboardingCompletedMiddleware
      >[0],
      next,
    );

    expect(result).toBe("ok");
    expect(next).toHaveBeenCalled();
  });
});
