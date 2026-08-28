import { beforeEach, describe, expect, mock, test } from "bun:test";

import { NEW_ASSISTANT_PARAM } from "@/domains/onboarding/onboarding-destination";
import { onboardingCompletedMiddleware } from "@/lib/onboarding-middleware";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
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
    beforeEach(() => {
      // A week-old assistant is what makes `alreadyOnboarded` true.
      useResolvedAssistantsStore.setState({
        assistants: [
          {
            id: "asst-old",
            hatchedAt: new Date(
              Date.now() - 30 * 24 * 60 * 60 * 1000,
            ).toISOString(),
            isLocal: true,
            isPlatformHosted: false,
            isPaired: false,
          },
        ],
        assistantsHydrated: true,
      });
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
