import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetSecureKey = mock<(key: string) => Promise<string | undefined>>(
  async () => undefined,
);
const mockSetSecureKey = mock<(key: string, value: string) => Promise<boolean>>(
  async () => true,
);

mock.module("../../../security/secure-keys.js", () => ({
  getSecureKeyAsync: mockGetSecureKey,
  setSecureKeyAsync: mockSetSecureKey,
}));

const mockRefreshOAuth2Token = mock<
  (...args: unknown[]) => Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
  }>
>(async () => ({
  accessToken: "new-access-token",
  refreshToken: "new-refresh-token",
  expiresIn: 3600,
}));

mock.module("../../../security/oauth2.js", () => ({
  refreshOAuth2Token: mockRefreshOAuth2Token,
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import {
  _resetRefreshMutex,
  getValidCodexAccessToken,
} from "../codex-token-refresh.js";

const PREFIX = "credential/openai-codex";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setSecureKeyMap(map: Record<string, string>): void {
  mockGetSecureKey.mockImplementation(async (key: string) => map[key]);
}

function futureTimestamp(secondsFromNow: number): string {
  return String(Math.floor(Date.now() / 1000) + secondsFromNow);
}

function pastTimestamp(secondsAgo: number): string {
  return String(Math.floor(Date.now() / 1000) - secondsAgo);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getValidCodexAccessToken", () => {
  beforeEach(() => {
    mockGetSecureKey.mockReset();
    mockSetSecureKey.mockReset();
    mockRefreshOAuth2Token.mockReset();
    _resetRefreshMutex();

    mockSetSecureKey.mockImplementation(async () => true);
    mockRefreshOAuth2Token.mockImplementation(async () => ({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresIn: 3600,
    }));
  });

  afterEach(() => {
    _resetRefreshMutex();
  });

  test("returns null when no access token is stored", async () => {
    setSecureKeyMap({});
    const result = await getValidCodexAccessToken(PREFIX);
    expect(result).toBeNull();
  });

  test("returns access token when no expires_at is stored (graceful degradation)", async () => {
    setSecureKeyMap({
      [`${PREFIX}/access_token`]: "my-token",
    });
    const result = await getValidCodexAccessToken(PREFIX);
    expect(result).toBe("my-token");
    expect(mockRefreshOAuth2Token).not.toHaveBeenCalled();
  });

  test("returns access token when not expired", async () => {
    setSecureKeyMap({
      [`${PREFIX}/access_token`]: "my-token",
      [`${PREFIX}/expires_at`]: futureTimestamp(600), // 10 minutes from now
    });
    const result = await getValidCodexAccessToken(PREFIX);
    expect(result).toBe("my-token");
    expect(mockRefreshOAuth2Token).not.toHaveBeenCalled();
  });

  test("refreshes token when expired", async () => {
    const keys: Record<string, string> = {
      [`${PREFIX}/access_token`]: "old-token",
      [`${PREFIX}/refresh_token`]: "old-refresh",
      [`${PREFIX}/expires_at`]: pastTimestamp(60), // expired 1 minute ago
    };
    setSecureKeyMap(keys);

    const result = await getValidCodexAccessToken(PREFIX);

    expect(result).toBe("new-access-token");
    expect(mockRefreshOAuth2Token).toHaveBeenCalledTimes(1);
    expect(mockRefreshOAuth2Token).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/token",
      "app_EMoamEEZ73f0CkXaXp7hrann",
      "old-refresh",
    );

    // Verify new tokens are stored
    expect(mockSetSecureKey).toHaveBeenCalledWith(
      `${PREFIX}/access_token`,
      "new-access-token",
    );
    expect(mockSetSecureKey).toHaveBeenCalledWith(
      `${PREFIX}/refresh_token`,
      "new-refresh-token",
    );
    // expires_at should be stored as well
    const expiresAtCall = mockSetSecureKey.mock.calls.find(
      (c) => c[0] === `${PREFIX}/expires_at`,
    );
    expect(expiresAtCall).toBeDefined();
    const storedExpiresAt = Number(expiresAtCall![1]);
    const now = Math.floor(Date.now() / 1000);
    // Should be approximately now + 3600 (within 5 seconds tolerance)
    expect(storedExpiresAt).toBeGreaterThan(now + 3590);
    expect(storedExpiresAt).toBeLessThanOrEqual(now + 3610);
  });

  test("refreshes token when about to expire (within 5-minute margin)", async () => {
    setSecureKeyMap({
      [`${PREFIX}/access_token`]: "old-token",
      [`${PREFIX}/refresh_token`]: "old-refresh",
      [`${PREFIX}/expires_at`]: futureTimestamp(60), // only 1 minute left
    });

    const result = await getValidCodexAccessToken(PREFIX);

    expect(result).toBe("new-access-token");
    expect(mockRefreshOAuth2Token).toHaveBeenCalledTimes(1);
  });

  test("concurrent refresh calls are deduplicated (mutex)", async () => {
    setSecureKeyMap({
      [`${PREFIX}/access_token`]: "old-token",
      [`${PREFIX}/refresh_token`]: "old-refresh",
      [`${PREFIX}/expires_at`]: pastTimestamp(60),
    });

    // Use a deferred promise to control when the refresh completes.
    // We create it upfront so the mock captures it synchronously.
    let resolveRefresh!: (v: {
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
    }) => void;
    const refreshPromise = new Promise<{
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
    }>((resolve) => {
      resolveRefresh = resolve;
    });

    mockRefreshOAuth2Token.mockImplementation(() => refreshPromise);

    // Fire two concurrent refreshes
    const p1 = getValidCodexAccessToken(PREFIX);
    const p2 = getValidCodexAccessToken(PREFIX);

    // Allow the async get-key calls to settle before resolving refresh
    await new Promise((r) => setTimeout(r, 10));

    // Resolve the single in-flight refresh
    resolveRefresh({
      accessToken: "shared-new-token",
      refreshToken: "shared-new-refresh",
      expiresIn: 3600,
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe("shared-new-token");
    expect(r2).toBe("shared-new-token");
    // Only one refresh call should have been made
    expect(mockRefreshOAuth2Token).toHaveBeenCalledTimes(1);
  });

  test("falls back to existing token when refresh fails", async () => {
    setSecureKeyMap({
      [`${PREFIX}/access_token`]: "old-token",
      [`${PREFIX}/refresh_token`]: "old-refresh",
      [`${PREFIX}/expires_at`]: pastTimestamp(60),
    });

    mockRefreshOAuth2Token.mockImplementation(async () => {
      throw new Error("OAuth2 token refresh failed (HTTP 400: invalid_grant)");
    });

    const result = await getValidCodexAccessToken(PREFIX);

    // Should fall back to the existing access token
    expect(result).toBe("old-token");
    expect(mockRefreshOAuth2Token).toHaveBeenCalledTimes(1);
  });

  test("falls back to existing token when no refresh token available", async () => {
    setSecureKeyMap({
      [`${PREFIX}/access_token`]: "old-token",
      // no refresh_token
      [`${PREFIX}/expires_at`]: pastTimestamp(60),
    });

    const result = await getValidCodexAccessToken(PREFIX);

    // Should return the existing access token
    expect(result).toBe("old-token");
    // Should not attempt a refresh
    expect(mockRefreshOAuth2Token).not.toHaveBeenCalled();
  });
});
