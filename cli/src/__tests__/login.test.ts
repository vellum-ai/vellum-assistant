import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import * as assistantConfig from "../lib/assistant-config.js";
import * as guardianToken from "../lib/guardian-token.js";
import * as platformClient from "../lib/platform-client.js";
import { buildBrowserLoginUrl, login } from "../commands/login.js";

const getActiveAssistantMock = spyOn(
  assistantConfig,
  "getActiveAssistant",
).mockReturnValue("my-local");

const findAssistantByNameMock = spyOn(
  assistantConfig,
  "findAssistantByName",
).mockReturnValue({
  assistantId: "my-local",
  runtimeUrl: "http://my-machine.local:7821",
  localUrl: "http://127.0.0.1:7821",
  bearerToken: "local-bearer",
  cloud: "local",
});

const loadLatestAssistantMock = spyOn(
  assistantConfig,
  "loadLatestAssistant",
).mockReturnValue(null);

const computeDeviceIdMock = spyOn(
  guardianToken,
  "computeDeviceId",
).mockReturnValue("device-id-123");

const fetchCurrentUserMock = spyOn(
  platformClient,
  "fetchCurrentUser",
).mockResolvedValue({
  id: "user-1",
  email: "test@example.com",
  display: "Test User",
});

const savePlatformTokenMock = spyOn(
  platformClient,
  "savePlatformToken",
).mockImplementation(() => {});

const fetchOrganizationIdMock = spyOn(
  platformClient,
  "fetchOrganizationId",
).mockResolvedValue("org-1");

const getPlatformUrlMock = spyOn(
  platformClient,
  "getPlatformUrl",
).mockReturnValue("https://platform.vellum.ai");

const bootstrapSelfHostedLocalAssistantCredentialsMock = spyOn(
  platformClient,
  "bootstrapSelfHostedLocalAssistantCredentials",
).mockRejectedValue(new Error("assistant unavailable"));

describe("login command", () => {
  let originalArgv: string[];
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalArgv = [...process.argv];
    process.argv = ["bun", "vellum", "login", "--token", "session-token"];

    getActiveAssistantMock.mockReset();
    getActiveAssistantMock.mockReturnValue("my-local");
    findAssistantByNameMock.mockReset();
    findAssistantByNameMock.mockReturnValue({
      assistantId: "my-local",
      runtimeUrl: "http://my-machine.local:7821",
      localUrl: "http://127.0.0.1:7821",
      bearerToken: "local-bearer",
      cloud: "local",
    });
    loadLatestAssistantMock.mockReset();
    loadLatestAssistantMock.mockReturnValue(null);
    computeDeviceIdMock.mockReset();
    computeDeviceIdMock.mockReturnValue("device-id-123");
    fetchCurrentUserMock.mockReset();
    fetchCurrentUserMock.mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      display: "Test User",
    });
    savePlatformTokenMock.mockReset();
    savePlatformTokenMock.mockImplementation(() => {});
    fetchOrganizationIdMock.mockReset();
    fetchOrganizationIdMock.mockResolvedValue("org-1");
    getPlatformUrlMock.mockReset();
    getPlatformUrlMock.mockReturnValue("https://platform.vellum.ai");
    bootstrapSelfHostedLocalAssistantCredentialsMock.mockReset();
    bootstrapSelfHostedLocalAssistantCredentialsMock.mockRejectedValue(
      new Error("assistant unavailable"),
    );

    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  afterAll(() => {
    getActiveAssistantMock.mockRestore();
    findAssistantByNameMock.mockRestore();
    loadLatestAssistantMock.mockRestore();
    computeDeviceIdMock.mockRestore();
    fetchCurrentUserMock.mockRestore();
    savePlatformTokenMock.mockRestore();
    fetchOrganizationIdMock.mockRestore();
    getPlatformUrlMock.mockRestore();
    bootstrapSelfHostedLocalAssistantCredentialsMock.mockRestore();
  });

  test("warns when assistant registration fails after successful login", async () => {
    await login();

    expect(savePlatformTokenMock).toHaveBeenCalledWith("session-token");
    expect(fetchCurrentUserMock).toHaveBeenCalledWith("session-token");
    expect(bootstrapSelfHostedLocalAssistantCredentialsMock).toHaveBeenCalledWith(
      {
        token: "session-token",
        organizationId: "org-1",
        clientInstallationId: "device-id-123",
        clientPlatform: "cli",
        entry: {
          assistantId: "my-local",
          runtimeUrl: "http://my-machine.local:7821",
          localUrl: "http://127.0.0.1:7821",
          bearerToken: "local-bearer",
          cloud: "local",
        },
        userId: "user-1",
        platformUrl: "https://platform.vellum.ai",
      },
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "Warning: logged in, but local assistant registration did not complete: assistant unavailable",
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

describe("buildBrowserLoginUrl", () => {
  test("targets the Django CLI callback endpoint on the platform host", () => {
    expect(
      buildBrowserLoginUrl(
        "https://dev-platform.vellum.ai",
        43123,
        "abcdef1234567890",
      ),
    ).toBe(
      "https://dev-platform.vellum.ai/accounts/cli/callback?port=43123&state=abcdef1234567890",
    );
  });

  test("trims a trailing slash from the base URL", () => {
    expect(
      buildBrowserLoginUrl(
        "https://dev-platform.vellum.ai/",
        43123,
        "abcdef1234567890",
      ),
    ).toBe(
      "https://dev-platform.vellum.ai/accounts/cli/callback?port=43123&state=abcdef1234567890",
    );
  });
});
