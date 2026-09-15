/**
 * Tests for `ProviderEditorContent` edit-mode save of Ollama Base URL.
 *
 * Create mode is owned by `ProviderCreateForm`; this file covers the PATCH
 * path for a keyless ollama connection.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { ProviderConnection } from "@/generated/daemon/types.gen";
import * as sdkGen from "@/generated/daemon/sdk.gen";

interface PatchConnectionCall {
  path: { assistant_id: string; name: string };
  body: Record<string, unknown>;
}

let patchCalls: PatchConnectionCall[] = [];
let patchedConnection: ProviderConnection;
let patchResponseOk = true;

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  secretsPost: () =>
    Promise.resolve({ data: undefined, response: { ok: true } }),
  inferenceProviderconnectionsByNamePatch: (opts: PatchConnectionCall) => {
    patchCalls.push(opts);
    return Promise.resolve({
      data: patchResponseOk ? patchedConnection : undefined,
      response: { ok: patchResponseOk, status: patchResponseOk ? 200 : 400 },
    });
  },
}));

mock.module("@/domains/settings/ai/use-stored-credential-presence", () => ({
  credentialPresenceQueryKey: (
    assistantId: string,
    kind: string,
    name: string,
  ) => ["credentialPresence", assistantId, kind, name] as const,
  useStoredCredentialPresence: () => ({
    hasStoredCredential: false,
    isLoading: false,
  }),
}));

mock.module("@/domains/settings/ai/use-provider-credentials-list", () => ({
  useProviderCredentialsList: () => ({
    credentials: [],
    isLoading: false,
  }),
}));

const { ProviderEditorContent } = await import(
  "@/domains/settings/ai/provider-editor-content"
);

const ASSISTANT_ID = "asst-1";

function ollamaConnection(
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  return {
    name: "ollama",
    label: null,
    provider: "ollama",
    auth: { type: "none" },
    baseUrl: null,
    models: null,
    createdAt: 0,
    updatedAt: 0,
    isManaged: false,
    ...overrides,
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function getInputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = Array.from(
    document.querySelectorAll<HTMLInputElement>("input"),
  ).find((el) => el.placeholder === placeholder);
  if (!input) {
    throw new Error(`expected an input with placeholder "${placeholder}"`);
  }
  return input;
}

function getButton(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.trim() === label);
  if (!match) {
    throw new Error(
      `expected a "${label}" button. Saw: ${Array.from(
        document.querySelectorAll("button"),
      )
        .map((b) => `"${b.textContent?.trim()}"`)
        .join(", ")}`,
    );
  }
  return match;
}

beforeEach(() => {
  patchCalls = [];
  patchedConnection = ollamaConnection({
    baseUrl: "http://192.168.1.50:11434/v1",
  });
  patchResponseOk = true;
});

afterEach(() => {
  cleanup();
});

describe("ProviderEditorContent ollama Base URL", () => {
  test("saving a filled URL PATCHes base_url", async () => {
    render(
      <Wrapper>
        <ProviderEditorContent
          mode="edit"
          variant="panel"
          connection={ollamaConnection()}
          assistantId={ASSISTANT_ID}
          existingNames={["ollama"]}
          onSave={() => {}}
          onCancel={() => {}}
        />
      </Wrapper>,
    );

    fireEvent.change(getInputByPlaceholder("http://127.0.0.1:11434/v1"), {
      target: { value: "http://192.168.1.50:11434/v1" },
    });
    fireEvent.click(getButton("Save Changes"));

    await waitFor(() => {
      expect(patchCalls.length).toBe(1);
    });
    expect(patchCalls[0].path).toEqual({
      assistant_id: ASSISTANT_ID,
      name: "ollama",
    });
    expect(patchCalls[0].body).toMatchObject({
      auth: { type: "none" },
      base_url: "http://192.168.1.50:11434/v1",
    });
    expect(patchCalls[0].body).not.toHaveProperty("models");
  });

  test("clearing the URL PATCHes base_url null", async () => {
    patchedConnection = ollamaConnection({ baseUrl: null });
    render(
      <Wrapper>
        <ProviderEditorContent
          mode="edit"
          variant="panel"
          connection={ollamaConnection({
            baseUrl: "http://192.168.1.50:11434/v1",
          })}
          assistantId={ASSISTANT_ID}
          existingNames={["ollama"]}
          onSave={() => {}}
          onCancel={() => {}}
        />
      </Wrapper>,
    );

    const input = getInputByPlaceholder("http://127.0.0.1:11434/v1");
    expect(input.value).toBe("http://192.168.1.50:11434/v1");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(getButton("Save Changes"));

    await waitFor(() => {
      expect(patchCalls.length).toBe(1);
    });
    expect(patchCalls[0].body).toMatchObject({
      auth: { type: "none" },
      base_url: null,
    });
  });
});
