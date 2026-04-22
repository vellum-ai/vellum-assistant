import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
const ATT_ID_1 = "att-001";
const ATT_ID_2 = "att-002";
const API_KEY_CREDENTIAL = credentialKey("vellum", "assistant_api_key");

const SAMPLE_ATTACHMENT_1 = {
  id: ATT_ID_1,
  filename: "invoice.pdf",
  content_type: "application/pdf",
  size_bytes: 245_000,
  content_id: "",
  created_at: "2026-04-05T12:00:00Z",
};

const SAMPLE_ATTACHMENT_2 = {
  id: ATT_ID_2,
  filename: "screenshot.png",
  content_type: "image/png",
  size_bytes: 1_200_000,
  content_id: "<img001@mail>",
  created_at: "2026-04-05T12:01:00Z",
};

function mockAttachmentList(
  attachments = [SAMPLE_ATTACHMENT_1, SAMPLE_ATTACHMENT_2],
  status = 200,
): void {
  mockFetch("/attachments/", {}, { body: { results: attachments }, status });
}

function mockAttachmentDetail(att = SAMPLE_ATTACHMENT_1, status = 200): void {
  mockFetch(`/attachments/${att.id}/`, {}, { body: att, status });
}

function mockAttachmentDownload(
  attId: string,
  content: string,
  status = 200,
): void {
  const body = new TextEncoder().encode(content);
  const response = new Response(body, {
    status,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(body.length),
    },
  });
  mockFetch(`/attachments/${attId}/download/`, {}, response);
}

let savedCesUrl: string | undefined;
let savedContainerized: string | undefined;
let tmpDir: string;

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

  tmpDir = join(tmpdir(), `email-attachment-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
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

  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
});

describe("assistant email attachment", () => {
  test("--list shows attachment metadata", async () => {
    mockAttachmentList();

    const output = await runAssistantCommand(
      "email",
      "attachment",
      MESSAGE_ID,
      "--list",
    );

    expect(output).toContain("invoice.pdf");
    expect(output).toContain("screenshot.png");
    expect(output).toContain("2 attachment(s)");
    expect(process.exitCode).toBe(0);
  });

  test("--list with no attachments", async () => {
    mockAttachmentList([]);

    const output = await runAssistantCommand(
      "email",
      "attachment",
      MESSAGE_ID,
      "--list",
    );

    expect(output).toContain("No attachments");
    expect(process.exitCode).toBe(0);
  });

  test("--list --json returns JSON", async () => {
    mockAttachmentList();

    const output = await runAssistantCommand(
      "email",
      "--json",
      "attachment",
      MESSAGE_ID,
      "--list",
    );

    const parsed = JSON.parse(output.trim());
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0].filename).toBe("invoice.pdf");
    expect(process.exitCode).toBe(0);
  });

  test("download single attachment by ID", async () => {
    mockAttachmentDetail(SAMPLE_ATTACHMENT_1);
    mockAttachmentDownload(ATT_ID_1, "fake-pdf-content");

    const output = await runAssistantCommand(
      "email",
      "attachment",
      MESSAGE_ID,
      ATT_ID_1,
      "-o",
      tmpDir,
    );

    expect(output).toContain("Downloaded invoice.pdf");
    expect(process.exitCode).toBe(0);

    const filePath = join(tmpDir, "invoice.pdf");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("fake-pdf-content");
  });

  test("download single attachment --json output", async () => {
    mockAttachmentDetail(SAMPLE_ATTACHMENT_1);
    mockAttachmentDownload(ATT_ID_1, "fake-pdf-content");

    const output = await runAssistantCommand(
      "email",
      "--json",
      "attachment",
      MESSAGE_ID,
      ATT_ID_1,
      "-o",
      tmpDir,
    );

    const parsed = JSON.parse(output.trim());
    expect(parsed.filename).toBe("invoice.pdf");
    expect(parsed.size_bytes).toBe(245_000);
    expect(parsed.saved).toContain("invoice.pdf");
    expect(process.exitCode).toBe(0);
  });

  test("--all downloads all attachments", async () => {
    mockAttachmentList();
    mockAttachmentDownload(ATT_ID_1, "pdf-bytes");
    mockAttachmentDownload(ATT_ID_2, "png-bytes");

    const output = await runAssistantCommand(
      "email",
      "attachment",
      MESSAGE_ID,
      "--all",
      "-o",
      tmpDir,
    );

    expect(output).toContain("Downloaded 2 attachment(s)");
    expect(output).toContain("invoice.pdf");
    expect(output).toContain("screenshot.png");
    expect(process.exitCode).toBe(0);

    expect(existsSync(join(tmpDir, "invoice.pdf"))).toBe(true);
    expect(existsSync(join(tmpDir, "screenshot.png"))).toBe(true);
    expect(readFileSync(join(tmpDir, "invoice.pdf"), "utf-8")).toBe(
      "pdf-bytes",
    );
    expect(readFileSync(join(tmpDir, "screenshot.png"), "utf-8")).toBe(
      "png-bytes",
    );
  });

  test("--all --json returns JSON", async () => {
    mockAttachmentList();
    mockAttachmentDownload(ATT_ID_1, "pdf-bytes");
    mockAttachmentDownload(ATT_ID_2, "png-bytes");

    const output = await runAssistantCommand(
      "email",
      "--json",
      "attachment",
      MESSAGE_ID,
      "--all",
      "-o",
      tmpDir,
    );

    const parsed = JSON.parse(output.trim());
    expect(parsed.downloaded).toBe(2);
    expect(parsed.files).toHaveLength(2);
    expect(process.exitCode).toBe(0);
  });

  test("--all with no attachments returns error", async () => {
    mockAttachmentList([]);

    const output = await runAssistantCommand(
      "email",
      "--json",
      "attachment",
      MESSAGE_ID,
      "--all",
      "-o",
      tmpDir,
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("No attachments");
  });

  test("no attachment-id and no --all returns error", async () => {
    const output = await runAssistantCommand(
      "email",
      "--json",
      "attachment",
      MESSAGE_ID,
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Specify an attachment ID");
  });

  test("calls correct list URL", async () => {
    mockAttachmentList();

    await runAssistantCommand("email", "attachment", MESSAGE_ID, "--list");

    // Filter out the CLI bootstrap fetch to /v1/feature-flags so this test
    // focuses on the attachment-related calls it actually cares about.
    const calls = getMockFetchCalls().filter(
      (c) => !c.path.includes("/v1/feature-flags"),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toContain(
      `/v1/assistants/${ASSISTANT_ID}/emails/${MESSAGE_ID}/attachments/`,
    );
  });

  test("calls correct detail + download URLs for single download", async () => {
    mockAttachmentDetail(SAMPLE_ATTACHMENT_1);
    mockAttachmentDownload(ATT_ID_1, "content");

    await runAssistantCommand(
      "email",
      "attachment",
      MESSAGE_ID,
      ATT_ID_1,
      "-o",
      tmpDir,
    );

    // Filter out the CLI bootstrap fetch to /v1/feature-flags so this test
    // focuses on the attachment-related calls it actually cares about.
    const calls = getMockFetchCalls().filter(
      (c) => !c.path.includes("/v1/feature-flags"),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].path).toContain(`/attachments/${ATT_ID_1}/`);
    expect(calls[1].path).toContain(`/attachments/${ATT_ID_1}/download/`);
  });

  test("404 on detail returns error", async () => {
    mockFetch(
      `/attachments/${ATT_ID_1}/`,
      {},
      { body: { detail: "Not found." }, status: 404 },
    );

    const output = await runAssistantCommand(
      "email",
      "--json",
      "attachment",
      MESSAGE_ID,
      ATT_ID_1,
      "-o",
      tmpDir,
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
      "attachment",
      MESSAGE_ID,
      "--list",
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
      "attachment",
      MESSAGE_ID,
      "--list",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Assistant ID");
  });

  test("formatBytes displays human-readable sizes", async () => {
    mockAttachmentList([
      { ...SAMPLE_ATTACHMENT_1, size_bytes: 500 },
      { ...SAMPLE_ATTACHMENT_2, size_bytes: 2_500_000 },
    ]);

    const output = await runAssistantCommand(
      "email",
      "attachment",
      MESSAGE_ID,
      "--list",
    );

    expect(output).toContain("500 B");
    expect(output).toContain("2.4 MB");
    expect(process.exitCode).toBe(0);
  });

  test("path traversal in filename is sanitized", async () => {
    mockAttachmentDetail({
      ...SAMPLE_ATTACHMENT_1,
      filename: "../../../etc/passwd",
    });
    mockAttachmentDownload(ATT_ID_1, "not-a-real-passwd");

    await runAssistantCommand(
      "email",
      "attachment",
      MESSAGE_ID,
      ATT_ID_1,
      "-o",
      tmpDir,
    );

    expect(process.exitCode).toBe(0);
    // Should NOT write to ../../../etc/passwd — should strip to just "passwd"
    expect(existsSync(join(tmpDir, "passwd"))).toBe(true);
    expect(existsSync("/etc/passwd-test")).toBe(false);
  });
});
