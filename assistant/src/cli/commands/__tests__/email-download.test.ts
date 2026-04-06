import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getMockFetchCalls,
  mockFetch,
  resetMockFetch,
} from "../../../__tests__/mock-fetch.js";
import { _setOverridesForTesting } from "../../../config/assistant-feature-flags.js";
import { setPlatformAssistantId } from "../../../config/env.js";
import { credentialKey } from "../../../security/credential-key.js";
import {
  _resetBackend,
  deleteSecureKeyAsync,
  setSecureKeyAsync,
} from "../../../security/secure-keys.js";
import { runAssistantCommand } from "../../__tests__/run-assistant-command.js";

const ASSISTANT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const MESSAGE_ID = "msg-001";
const API_KEY_CREDENTIAL = credentialKey("vellum", "assistant_api_key");

const SAMPLE_MESSAGE = {
  id: MESSAGE_ID,
  direction: "inbound",
  from_address: "user@example.com",
  to_addresses: ["mybot@vellum.me"],
  subject: "Hello bot",
  body_text: "Hi, this is a test message.",
  body_html: "<p>Hi, this is a <b>test</b> message.</p>",
  in_reply_to: "",
  references: [],
  created_at: "2026-04-05T12:00:00Z",
};

function mockDetailSuccess(msg = SAMPLE_MESSAGE, status = 200): void {
  mockFetch(`/emails/${msg.id}/`, {}, { body: msg, status });
}

let savedCesUrl: string | undefined;
let savedContainerized: string | undefined;
let tmpOutputPath: string;

beforeEach(async () => {
  process.exitCode = 0;

  savedCesUrl = process.env.CES_CREDENTIAL_URL;
  savedContainerized = process.env.IS_CONTAINERIZED;
  delete process.env.CES_CREDENTIAL_URL;
  delete process.env.IS_CONTAINERIZED;

  _resetBackend();
  resetMockFetch();
  _setOverridesForTesting({ "email-channel": true });
  setPlatformAssistantId(ASSISTANT_ID);
  await setSecureKeyAsync(API_KEY_CREDENTIAL, "test-api-key");

  tmpOutputPath = join(tmpdir(), `email-download-test-${Date.now()}.txt`);
});

afterEach(() => {
  resetMockFetch();
  _setOverridesForTesting({});
  setPlatformAssistantId(undefined);
  _resetBackend();

  if (savedCesUrl !== undefined) process.env.CES_CREDENTIAL_URL = savedCesUrl;
  else delete process.env.CES_CREDENTIAL_URL;
  if (savedContainerized !== undefined)
    process.env.IS_CONTAINERIZED = savedContainerized;
  else delete process.env.IS_CONTAINERIZED;

  if (existsSync(tmpOutputPath)) rmSync(tmpOutputPath);
});

describe("assistant email download", () => {
  test("default format shows headers and plain-text body", async () => {
    mockDetailSuccess();

    const output = await runAssistantCommand("email", "download", MESSAGE_ID);

    expect(output).toContain("From:    user@example.com");
    expect(output).toContain("To:      mybot@vellum.me");
    expect(output).toContain("Subject: Hello bot");
    expect(output).toContain("Hi, this is a test message.");
    expect(process.exitCode).toBe(0);
  });

  test("--format json returns full message object", async () => {
    mockDetailSuccess();

    const output = await runAssistantCommand(
      "email",
      "download",
      MESSAGE_ID,
      "--format",
      "json",
    );

    const parsed = JSON.parse(output.trim());
    expect(parsed.id).toBe(MESSAGE_ID);
    expect(parsed.body_text).toBe("Hi, this is a test message.");
    expect(parsed.body_html).toContain("<b>test</b>");
    expect(process.exitCode).toBe(0);
  });

  test("--json flag also returns JSON", async () => {
    mockDetailSuccess();

    const output = await runAssistantCommand(
      "email",
      "--json",
      "download",
      MESSAGE_ID,
    );

    const parsed = JSON.parse(output.trim());
    expect(parsed.id).toBe(MESSAGE_ID);
    expect(process.exitCode).toBe(0);
  });

  test("--format html returns HTML body", async () => {
    mockDetailSuccess();

    const output = await runAssistantCommand(
      "email",
      "download",
      MESSAGE_ID,
      "--format",
      "html",
    );

    expect(output).toContain("<p>Hi, this is a <b>test</b> message.</p>");
    expect(process.exitCode).toBe(0);
  });

  test("--format html with no HTML body returns error", async () => {
    mockDetailSuccess({ ...SAMPLE_MESSAGE, body_html: "" });

    const output = await runAssistantCommand(
      "email",
      "download",
      MESSAGE_ID,
      "--format",
      "html",
    );

    expect(process.exitCode).toBe(1);
    // stderr output from log.error, but stdout may be empty — check exitCode
    expect(output).not.toContain("<p>");
  });

  test("--output writes to file", async () => {
    mockDetailSuccess();

    await runAssistantCommand(
      "email",
      "download",
      MESSAGE_ID,
      "-o",
      tmpOutputPath,
    );

    expect(process.exitCode).toBe(0);
    expect(existsSync(tmpOutputPath)).toBe(true);
    const content = readFileSync(tmpOutputPath, "utf-8");
    expect(content).toContain("From:    user@example.com");
    expect(content).toContain("Hi, this is a test message.");
  });

  test("calls correct URL", async () => {
    mockDetailSuccess();

    await runAssistantCommand("email", "download", MESSAGE_ID);

    const calls = getMockFetchCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toContain(
      `/v1/assistants/${ASSISTANT_ID}/emails/${MESSAGE_ID}/`,
    );
  });

  test("404 returns error", async () => {
    mockFetch(
      `/emails/${MESSAGE_ID}/`,
      {},
      { body: { detail: "Not found." }, status: 404 },
    );

    const output = await runAssistantCommand(
      "email",
      "--json",
      "download",
      MESSAGE_ID,
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Not found");
  });

  test("missing platform credentials returns error", async () => {
    await deleteSecureKeyAsync(API_KEY_CREDENTIAL);

    const output = await runAssistantCommand(
      "email",
      "--json",
      "download",
      MESSAGE_ID,
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Platform credentials not configured");
  });

  test("missing assistant ID returns error", async () => {
    setPlatformAssistantId("");

    const output = await runAssistantCommand(
      "email",
      "--json",
      "download",
      MESSAGE_ID,
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Assistant ID");
  });

  test("in_reply_to header shown when present", async () => {
    mockDetailSuccess({
      ...SAMPLE_MESSAGE,
      in_reply_to: "<orig@mail.gmail.com>",
    });

    const output = await runAssistantCommand("email", "download", MESSAGE_ID);

    expect(output).toContain("In-Reply-To: <orig@mail.gmail.com>");
    expect(process.exitCode).toBe(0);
  });
});
