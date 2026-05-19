/**
 * Tests for `ConnectAssistantDialog`.
 *
 * The dialog uses hooks (useState, useMutation) so we can't render its tree
 * from a plain function call. We use source pinning (same convention as
 * `contact-merge-dialog.test.tsx`) to verify structural contracts and a smoke
 * test to confirm the export wiring.
 */

import { describe, expect, test } from "bun:test";
import { _isValidElement, _createElement } from "react";

import { ConnectAssistantDialog } from "@/components/app/intelligence/contacts/connect-assistant-dialog.js";

async function readSource(): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  return fs.readFile(
    path.join(import.meta.dir, "connect-assistant-dialog.tsx"),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Source pinning — structural contracts
// ---------------------------------------------------------------------------

describe("ConnectAssistantDialog — source pinning", () => {
  test("composes the Modal primitive with size sm", async () => {
    const source = await readSource();
    expect(source).toContain("<Modal.Root");
    expect(source).toContain('<Modal.Content size="sm"');
    expect(source).toContain("<Modal.Header>");
    expect(source).toContain("<Modal.Body>");
    expect(source).toContain("<Modal.Footer>");
  });

  test("title is 'Connect to Assistant'", async () => {
    const source = await readSource();
    expect(source).toContain("Connect to Assistant");
  });

  test("renders Handle and Gateway URL input fields", async () => {
    const source = await readSource();
    expect(source).toContain('label="Handle"');
    expect(source).toContain('label="Gateway URL"');
    expect(source).toContain('placeholder="e.g. alice-assistant"');
    expect(source).toContain('placeholder="e.g. https://alice.vellum.app"');
  });

  test("both inputs are required", async () => {
    const source = await readSource();
    // Both Input components have the required prop
    const requiredMatches = source.match(/required/g);
    expect(requiredMatches).not.toBeNull();
    expect(requiredMatches!.length).toBeGreaterThanOrEqual(2);
  });

  test("Connect button is disabled when fields are empty or mutation is pending", async () => {
    const source = await readSource();
    expect(source).toContain("disabled={!canSubmit}");
    expect(source).toContain("guardianHandle.trim().length > 0");
    expect(source).toContain("gatewayUrl.trim().length > 0");
    expect(source).toContain("!mutation.isPending");
  });

  test("footer renders Cancel and Connect buttons", async () => {
    const source = await readSource();
    expect(source).toMatch(/<Button[^>]*variant="outlined"[\s\S]*?Cancel/);
    expect(source).toContain("Connect\n");
    expect(source).toContain("disabled={!canSubmit}");
  });

  test("on successful mutation, calls onSuccess with contactId", async () => {
    const source = await readSource();
    expect(source).toContain("onSuccess(data.contactId)");
  });

  test("alreadyConnected response is treated same as normal success (no special branch)", async () => {
    const source = await readSource();
    // The onSuccess handler should not check alreadyConnected
    expect(source).not.toContain("alreadyConnected");
  });

  test("on error, displays error message with negative-strong token", async () => {
    const source = await readSource();
    expect(source).toContain("mutation.isError");
    expect(source).toContain("system-negative-strong");
    expect(source).toContain('role="alert"');
  });

  test("closing dialog resets form state and mutation", async () => {
    const source = await readSource();
    // handleClose resets guardianHandle, gatewayUrl, and calls mutation.reset()
    expect(source).toContain('setGuardianHandle("")');
    expect(source).toContain('setGatewayUrl("")');
    expect(source).toContain("mutation.reset()");
  });

  test("Modal.Root onOpenChange calls handleClose when closing", async () => {
    const source = await readSource();
    expect(source).toContain("onOpenChange");
    expect(source).toContain("if (!nextOpen) handleClose()");
  });

  test("helper text is shown below Gateway URL input", async () => {
    const source = await readSource();
    expect(source).toContain(
      "The assistant&apos;s gateway URL. Required for all connections.",
    );
  });
});

// ---------------------------------------------------------------------------
// Smoke
// ---------------------------------------------------------------------------

describe("ConnectAssistantDialog smoke", () => {
  test("ConnectAssistantDialog is a function component", () => {
    expect(typeof ConnectAssistantDialog).toBe("function");
  });
});
