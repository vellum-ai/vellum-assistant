import { afterEach, describe, expect, mock, test } from "bun:test";

// Capture the `client` path param each allauth SDK call receives.
const calls: Array<{ fn: string; client: string }> = [];

/** Body each stubbed call resolves with; tests swap it per scenario. */
const stubBody = { value: {} as unknown };

function sdkStub(fn: string) {
  return (opts: { path: { client: string } }) => {
    calls.push({ fn, client: opts.path.client });
    return Promise.resolve({
      data: { data: stubBody.value },
      error: undefined,
      response: { status: 200 },
    });
  };
}

mock.module("@/generated/auth/sdk.gen", () => ({
  getAllauthByClientV1AuthSession: sdkStub("getSession"),
  getAllauthByClientV1Config: sdkStub("getAuthConfig"),
  deleteAllauthByClientV1AuthSession: sdkStub("logout"),
  getAllauthByClientV1AuthProviderSignup: sdkStub("getProviderSignup"),
  postAllauthByClientV1AuthProviderSignup: sdkStub("submitProviderSignup"),
}));

const { getAuthConfig, getSession, logout } =
  await import("@/lib/auth/allauth-client");

function setElectron(): void {
  (window as unknown as { vellum?: unknown }).vellum = { platform: "electron" };
}

afterEach(() => {
  delete (window as unknown as { vellum?: unknown }).vellum;
  calls.length = 0;
  stubBody.value = {};
});

describe("allauth-client — client selection", () => {
  test("uses the browser client on web", async () => {
    await getSession();
    expect(calls.at(-1)?.client).toBe("browser");
  });

  test("uses the app client in Electron", async () => {
    setElectron();
    await getSession();
    await logout();
    await getAuthConfig();
    expect(calls.map((c) => c.client)).toEqual(["app", "app", "app"]);
  });
});

describe("allauth-client — getAuthConfig", () => {
  test("returns the consumed slice of a well-formed configuration", async () => {
    stubBody.value = {
      account: { is_open_for_signup: false, login_by_code_enabled: true },
      socialaccount: { providers: [] },
    };
    const result = await getAuthConfig();

    expect(result).toEqual({
      ok: true,
      data: { account: { is_open_for_signup: false } },
    });
  });

  test("a payload without the account block is an error, not a partial success", async () => {
    stubBody.value = { socialaccount: { providers: [] } };
    const result = await getAuthConfig();

    expect(result.ok).toBe(false);
  });
});
