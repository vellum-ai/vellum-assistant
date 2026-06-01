import { beforeEach, describe, expect, mock, test } from "bun:test";

import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import { onboardingCompletedMiddleware } from "@/lib/onboarding-middleware";
import { routes } from "@/utils/routes";

function makeRequest(path: string): Request {
  return new Request(`https://example.com${path}`);
}

describe("onboardingCompletedMiddleware", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useOnboardingStore.getState().setOnboardingCompleted(false);
  });

  test("allows local pre-chat after hatch when onboarding is not complete", async () => {
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
    const next = mock(() => "ok");

    const result = await onboardingCompletedMiddleware(
      { request: makeRequest(routes.onboarding.prechat) } as Parameters<
        typeof onboardingCompletedMiddleware
      >[0],
      next,
    );

    expect(result).toBe("ok");
    expect(next).toHaveBeenCalled();
  });

  test("redirects completed onboarding unless replay is present", async () => {
    useOnboardingStore.getState().setOnboardingCompleted(true);

    const redirectResponse = await onboardingCompletedMiddleware(
      { request: makeRequest(routes.onboarding.prechat) } as Parameters<
        typeof onboardingCompletedMiddleware
      >[0],
      mock(() => "ok"),
    ).catch((err: unknown) => err);

    expect(redirectResponse).toBeInstanceOf(Response);
    expect((redirectResponse as Response).headers.get("Location")).toBe(
      routes.assistant,
    );
  });

  test("allows replay even when onboarding is complete", async () => {
    useOnboardingStore.getState().setOnboardingCompleted(true);
    const next = mock(() => "ok");

    const result = await onboardingCompletedMiddleware(
      {
        request: makeRequest(`${routes.onboarding.prechat}?replay=1`),
      } as Parameters<typeof onboardingCompletedMiddleware>[0],
      next,
    );

    expect(result).toBe("ok");
    expect(next).toHaveBeenCalled();
  });
});
