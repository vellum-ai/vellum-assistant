import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  type RedirectedSecretRecord,
  redirectToSecurePrompt,
} from "../daemon/conversation-messaging.js";
import type { SecretPrompter } from "../permissions/secret-prompter.js";
import { credentialKey } from "../security/credential-key.js";

const setSecureKeyMock = mock((_key?: string, _value?: string) => true);
const upsertCredentialMetadataMock = mock(
  (_service?: string, _field?: string, _metadata?: unknown) => {},
);
const metadataByKey = new Map<
  string,
  {
    credentialId: string;
    service: string;
    field: string;
    allowedTools: string[];
    allowedDomains: string[];
    createdAt: number;
    updatedAt: number;
  }
>();

mock.module("../security/secure-keys.js", () => ({
  setSecureKeyAsync: async (key?: string, value?: string) =>
    setSecureKeyMock(key, value),
  deleteSecureKeyAsync: async () => "deleted" as const,
  listSecureKeysAsync: async () => [],
  _resetBackend: () => {},
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  assertMetadataWritable: () => {},
  upsertCredentialMetadata: (service: string, field: string) => {
    upsertCredentialMetadataMock(service, field, {});
    const key = `${service}:${field}`;
    const now = Date.now();
    metadataByKey.set(key, {
      credentialId: `cred-${service}-${field}`,
      service,
      field,
      allowedTools: [],
      allowedDomains: [],
      createdAt: now,
      updatedAt: now,
    });
  },
  getCredentialMetadata: (service: string, field: string) =>
    metadataByKey.get(`${service}:${field}`),
  getCredentialMetadataById: (credentialId: string) =>
    Array.from(metadataByKey.values()).find(
      (m) => m.credentialId === credentialId,
    ),
  listCredentialMetadata: () => Array.from(metadataByKey.values()),
  deleteCredentialMetadata: (service: string, field: string) => {
    metadataByKey.delete(`${service}:${field}`);
  },
  _setMetadataPath: () => {},
}));

describe("session-messaging secret redirect", () => {
  beforeEach(() => {
    setSecureKeyMock.mockReset();
    upsertCredentialMetadataMock.mockReset();
    metadataByKey.clear();
    setSecureKeyMock.mockImplementation(() => true);
  });

  test("maps Telegram Bot Token to canonical credential key and emits stored callback", async () => {
    const promptCalls: Array<{
      service: string;
      field: string;
      label: string;
    }> = [];
    const fakePrompter = {
      prompt: (service: string, field: string, label: string) => {
        promptCalls.push({ service, field, label });
        return Promise.resolve({
          value: "123456789:ABCDefGHIJklmnopQRSTuvwxyz012345678",
          delivery: "store" as const,
        });
      },
    } as unknown as SecretPrompter;

    let callbackRecord: RedirectedSecretRecord | undefined;

    await new Promise<void>((resolve) => {
      redirectToSecurePrompt("conv-1", fakePrompter, ["Telegram Bot Token"], {
        onStored: (record) => {
          callbackRecord = record;
          resolve();
        },
      });
    });

    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]).toEqual({
      service: "telegram",
      field: "bot_token",
      label: "Telegram Bot Token",
    });
    expect(setSecureKeyMock).toHaveBeenCalledWith(
      credentialKey("telegram", "bot_token"),
      "123456789:ABCDefGHIJklmnopQRSTuvwxyz012345678",
    );
    expect(upsertCredentialMetadataMock).toHaveBeenCalledWith(
      "telegram",
      "bot_token",
      {},
    );
    expect(callbackRecord).toEqual({
      service: "telegram",
      field: "bot_token",
      label: "Telegram Bot Token",
      delivery: "store",
    });
  });

  test("prefers canonical target when one mapped type is detected alongside generic detections", async () => {
    const promptCalls: Array<{
      service: string;
      field: string;
      label: string;
    }> = [];
    const fakePrompter = {
      prompt: (service: string, field: string, label: string) => {
        promptCalls.push({ service, field, label });
        return Promise.resolve({
          value: "123456789:ABCDefGHIJklmnopQRSTuvwxyz012345678",
          delivery: "store" as const,
        });
      },
    } as unknown as SecretPrompter;

    await new Promise<void>((resolve) => {
      redirectToSecurePrompt(
        "conv-1",
        fakePrompter,
        ["Telegram Bot Token", "High-Entropy Base64 Token"],
        {
          onStored: () => resolve(),
        },
      );
    });

    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]).toEqual({
      service: "telegram",
      field: "bot_token",
      label: "Telegram Bot Token",
    });
    expect(setSecureKeyMock).toHaveBeenCalledWith(
      credentialKey("telegram", "bot_token"),
      "123456789:ABCDefGHIJklmnopQRSTuvwxyz012345678",
    );
  });

  test("maps encoded known types to canonical credential key", async () => {
    const promptCalls: Array<{
      service: string;
      field: string;
      label: string;
    }> = [];
    const fakePrompter = {
      prompt: (service: string, field: string, label: string) => {
        promptCalls.push({ service, field, label });
        return Promise.resolve({
          value: "123456789:ABCDefGHIJklmnopQRSTuvwxyz012345678",
          delivery: "store" as const,
        });
      },
    } as unknown as SecretPrompter;

    await new Promise<void>((resolve) => {
      redirectToSecurePrompt(
        "conv-1",
        fakePrompter,
        ["Telegram Bot Token (base64-encoded)"],
        {
          onStored: () => resolve(),
        },
      );
    });

    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]).toEqual({
      service: "telegram",
      field: "bot_token",
      label: "Telegram Bot Token",
    });
    expect(setSecureKeyMock).toHaveBeenCalledWith(
      credentialKey("telegram", "bot_token"),
      "123456789:ABCDefGHIJklmnopQRSTuvwxyz012345678",
    );
  });

  test("falls back to detected credential namespace for unknown secret types", async () => {
    const promptCalls: Array<{
      service: string;
      field: string;
      label: string;
    }> = [];
    const fakePrompter = {
      prompt: (service: string, field: string, label: string) => {
        promptCalls.push({ service, field, label });
        return Promise.resolve({
          value: "opaque-secret",
          delivery: "store" as const,
        });
      },
    } as unknown as SecretPrompter;

    await new Promise<void>((resolve) => {
      redirectToSecurePrompt("conv-1", fakePrompter, ["Some Unknown Secret"], {
        onStored: () => resolve(),
      });
    });

    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]).toEqual({
      service: "detected",
      field: "Some Unknown Secret",
      label: "Secure Credential Entry",
    });
    expect(setSecureKeyMock).toHaveBeenCalledWith(
      credentialKey("detected", "Some Unknown Secret"),
      "opaque-secret",
    );
    expect(upsertCredentialMetadataMock).toHaveBeenCalledWith(
      "detected",
      "Some Unknown Secret",
      {},
    );
  });
});
