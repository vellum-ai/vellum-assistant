import { beforeEach, describe, expect, mock, test } from "bun:test";

import { onboardingCompletedMiddleware } from "@/lib/onboarding-middleware";
import { routes } from "@/utils/routes";

function makeRequest(path: string): Request {
  return new Request(`https://example.com${path}`);
}

describe("onboardingCompletedMiddleware", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
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
    const next = mock(async () => "ok");

    const result = await onboardingCompletedMiddleware(
      { request: makeRequest(routes.onboarding.prechat) } as Parameters<
        typeof onboardingCompletedMiddleware
      >[0],
      next,
    );

    expect(result).toBe("ok");
    expect(next).toHaveBeenCalled();
  });

});
