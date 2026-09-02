import { afterEach, beforeEach, describe, test, expect, mock } from "bun:test";
import { setVelayBridgeAuthHeader } from "../velay/bridge-auth.js";
import { getLogger } from "../logger.js";
import {
  GUARDIAN_PRINCIPAL,
  VELAY_USER_ID,
  makeConfig,
  mintEdgeToken,
  mintServiceEdgeToken,
} from "./runtime-stream-test-utils.js";

// Both lookups are mocked BEFORE the module under test is imported, so the
// pin is testable without gateway DB state.
let mockFindVellumGuardian = mock(
  async (): Promise<{ principalId: string } | null> => ({
    principalId: GUARDIAN_PRINCIPAL,
  }),
);
mock.module("../auth/guardian-bootstrap.js", () => ({
  findVellumGuardian: () => mockFindVellumGuardian(),
}));

let mockReadCredential = mock(
  async (_key: string): Promise<string | undefined> => VELAY_USER_ID,
);
mock.module("../credential-reader.js", () => ({
  readCredential: (key: string) => mockReadCredential(key),
}));

const { authorizeGuardianStream } =
  await import("../http/routes/guardian-pin.js");

const log = getLogger("guardian-pin-test");
const STREAM_URL = "http://localhost:7830/v1/watch/stream";

beforeEach(() => {
  mockFindVellumGuardian = mock(async () => ({
    principalId: GUARDIAN_PRINCIPAL,
  }));
  mockReadCredential = mock(async (_key: string) => VELAY_USER_ID);
});

afterEach(() => {
  delete process.env.IS_PLATFORM;
});

/**
 * The proxies replace the caller's identity with a service token upstream, so
 * the daemon cannot tell one actor from another: whoever this gate admits is
 * treated as the owner. This is the only place a non-guardian can be refused.
 */
describe("authorizeGuardianStream: the actor token path", () => {
  const authorize = (token?: string, config = makeConfig()) =>
    authorizeGuardianStream(
      new Request(token ? `${STREAM_URL}?token=${token}` : STREAM_URL, {
        headers: { upgrade: "websocket" },
      }),
      config,
      log,
    );

  test("admits the bound guardian", async () => {
    expect(await authorize(mintEdgeToken(GUARDIAN_PRINCIPAL))).toBeNull();
  });

  test("refuses a valid actor token that is not the bound guardian", async () => {
    const res = await authorize(mintEdgeToken("someone-else"));

    expect(res!.status).toBe(403);
  });

  test("refuses when no guardian binding exists", async () => {
    mockFindVellumGuardian = mock(async () => null);

    const res = await authorize(mintEdgeToken(GUARDIAN_PRINCIPAL));

    expect(res!.status).toBe(403);
  });

  /**
   * A lookup that throws leaves the answer unknown. Reporting that as
   * "forbidden" would misread a database problem as a permission one.
   */
  test("answers 503 when the binding lookup fails", async () => {
    mockFindVellumGuardian = mock(async () => {
      throw new Error("db down");
    });

    const res = await authorize(mintEdgeToken(GUARDIAN_PRINCIPAL));

    expect(res!.status).toBe(503);
  });

  test("returns 401 when no token is provided", async () => {
    const res = await authorize();

    expect(res!.status).toBe(401);
    expect(mockFindVellumGuardian).not.toHaveBeenCalled();
  });

  test("returns 401 for a service token, which has no actor principal", async () => {
    const res = await authorize(mintServiceEdgeToken());

    expect(res!.status).toBe(401);
  });

  test("returns 426 when the request is not a WebSocket upgrade", async () => {
    const res = await authorizeGuardianStream(
      new Request(`${STREAM_URL}?token=${mintEdgeToken()}`),
      makeConfig(),
      log,
    );

    expect(res!.status).toBe(426);
  });

  /** The dev bypass validates no token, so there is no principal to pin. */
  test("admits an unauthenticated caller when auth is disabled", async () => {
    const res = await authorize(
      undefined,
      makeConfig({ runtimeProxyRequireAuth: false }),
    );

    expect(res).toBeNull();
    expect(mockFindVellumGuardian).not.toHaveBeenCalled();
  });
});

/**
 * The managed path, where velay validated the browser's token and injected the
 * caller. The attestation proves the caller is *a* platform user who traversed
 * velay, not that they are this assistant's guardian, so it is cross-checked
 * against the stored `platform_user_id`.
 */
describe("authorizeGuardianStream: the velay-attested managed path", () => {
  const VELAY_ORG_ID = "22222222-2222-2222-2222-222222222222";

  const managedAuthorize = ({
    userId = VELAY_USER_ID,
    actor = "user",
    orgId = VELAY_ORG_ID as string | null,
    bridgeProof = true,
    token,
    managed = true,
    upgrade = true,
  }: {
    userId?: string;
    actor?: string;
    orgId?: string | null;
    bridgeProof?: boolean;
    token?: string;
    managed?: boolean;
    upgrade?: boolean;
  }) => {
    if (managed) {
      process.env.IS_PLATFORM = "true";
    } else {
      delete process.env.IS_PLATFORM;
    }
    const headers = new Headers({
      "x-velay-user-id": userId,
      "x-velay-actor": actor,
    });
    if (upgrade) {
      headers.set("upgrade", "websocket");
    }
    if (orgId !== null) {
      headers.set("x-velay-org-id", orgId);
    }
    if (bridgeProof) {
      setVelayBridgeAuthHeader(headers);
    }
    const query = token ? `?token=${token}` : "";
    return authorizeGuardianStream(
      new Request(`${STREAM_URL}${query}`, { headers }),
      makeConfig(),
      log,
    );
  };

  test("admits an attested caller who is the bound guardian", async () => {
    expect(await managedAuthorize({})).toBeNull();
  });

  test("refuses an attested caller who is not the bound guardian", async () => {
    mockReadCredential = mock(
      async () => "99999999-9999-9999-9999-999999999999",
    );

    const res = await managedAuthorize({});

    expect(res!.status).toBe(403);
  });

  test("refuses when this assistant has no platform user stored", async () => {
    mockReadCredential = mock(async () => undefined);

    const res = await managedAuthorize({});

    expect(res!.status).toBe(403);
  });

  test("answers 503 when the platform user lookup fails", async () => {
    mockReadCredential = mock(async () => {
      throw new Error("credential store down");
    });

    const res = await managedAuthorize({});

    expect(res!.status).toBe(503);
  });

  /**
   * A direct request to a reachable gateway can spoof the header names. It
   * cannot know the process-local bridge proof, which is what says the request
   * really arrived through this gateway's own loopback bridge.
   */
  test("ignores spoofed velay headers with no bridge proof", async () => {
    const res = await managedAuthorize({ bridgeProof: false });

    expect(res!.status).toBe(401);
    expect(mockReadCredential).not.toHaveBeenCalled();
  });

  test("falls through to the token path on an incomplete attestation", async () => {
    const res = await managedAuthorize({
      orgId: null,
      token: mintEdgeToken(GUARDIAN_PRINCIPAL),
    });

    expect(res).toBeNull();
  });

  /** Falling through must not fall past the pin. */
  test("still pins the token path in managed mode", async () => {
    const res = await managedAuthorize({
      actor: "service",
      token: mintEdgeToken("someone-else"),
    });

    expect(res!.status).toBe(403);
  });

  test("does not trust velay headers outside managed mode", async () => {
    const res = await managedAuthorize({ managed: false });

    expect(res!.status).toBe(401);
  });

  /**
   * The managed path skips the shared gate, so the upgrade header is checked
   * before it: a plain managed request must get 426, not a failed upgrade.
   */
  test("answers 426 for a plain request even when velay attests the guardian", async () => {
    const res = await managedAuthorize({ upgrade: false });

    expect(res!.status).toBe(426);
    expect(mockReadCredential).not.toHaveBeenCalled();
  });
});
