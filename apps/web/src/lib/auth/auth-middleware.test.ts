import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const isLocalModeMock = mock(() => true);
const hasAssistantsMock = mock(() => false);
mock.module("@/lib/local-mode", () => ({
  isLocalMode: isLocalModeMock,
  hasAssistants: hasAssistantsMock,
  getLocalGatewayUrl: () => undefined,
}));

import { authMiddleware } from "./auth-middleware";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useAuthStore, type AuthUser } from "@/stores/auth-store";
import { routes } from "@/utils/routes";

const initialAuthState = useAuthStore.getState();
const fakeUser = { id: "user-123" } as AuthUser;

async function runMiddleware(pathname: string): Promise<Response> {
  const args = {
    request: new Request(`http://localhost${pathname}`),
    context: { set: () => {}, get: () => null },
  } as unknown as Parameters<typeof authMiddleware>[0];
  const next = (async () => new Response()) as Parameters<
    typeof authMiddleware
  >[1];
  // The middleware signals an unauthenticated/onboarding redirect by *throwing*
  // a Response, so surface that as the resolved value for assertions.
  try {
    await authMiddleware(args, next);
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
  throw new Error("expected a redirect to be thrown");
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  isLocalModeMock.mockImplementation(() => true);
  hasAssistantsMock.mockImplementation(() => false);
  useAuthStore.setState(initialAuthState, true);
  useAssistantLifecycleStore.setState({ assistantState: { kind: "error", message: "no assistant" } });
});

afterEach(() => {
  useAuthStore.setState(initialAuthState, true);
});

describe("authMiddleware — local-mode onboarding fork", () => {
  test("waits for the platform-session probe before choosing hosting vs welcome", async () => {
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      platformSession: "unknown",
    });

    let settled: Response | null = null;
    const pending = runMiddleware(routes.home).then((res) => {
      settled = res;
    });

    // Probe still in flight: the middleware must not have decided yet, so a
    // returning platform user isn't prematurely sent to the welcome flow.
    await tick();
    expect(settled).toBeNull();

    // Probe settles with a live platform session.
    useAuthStore.setState({ platformSession: "present" });
    await pending;

    expect(settled).not.toBeNull();
    expect(settled!.status).toBe(302);
    expect(settled!.headers.get("Location")).toBe(routes.onboarding.hosting);
  });

  test("routes to welcome once resolved with no platform session", async () => {
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      platformSession: "absent",
    });

    const res = await runMiddleware(routes.home);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(routes.welcome);
  });

  test("routes to hosting when a resolved platform session exists", async () => {
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      platformSession: "present",
    });

    const res = await runMiddleware(routes.home);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(routes.onboarding.hosting);
  });
});
