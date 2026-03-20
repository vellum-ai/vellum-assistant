import { saveAssistantEntry, setActiveAssistant } from "./assistant-config";
import type { AssistantEntry } from "./assistant-config";
import type { Species } from "./constants";
import { getPlatformUrl, readPlatformToken } from "./platform-client";

interface HatchResponse {
  id: string;
  name: string;
  description: string | null;
  status: string;
  created: string;
  modified: string;
}

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

function requirePlatformToken(): string {
  const token = readPlatformToken();
  if (!token) {
    throw new Error("Not logged in to Vellum. Please run `vel login` first.");
  }
  return token;
}

export async function hatchPlatform(
  species: Species,
  name: string | null,
): Promise<void> {
  const token = requirePlatformToken();
  const platformUrl = getPlatformUrl();

  console.log("\n\u{1F95A} Creating platform assistant...\n");

  const body: Record<string, string> = {};
  if (name) {
    body.name = name;
  }

  const hatchResponse = await fetch(`${platformUrl}/v1/assistants/hatch/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": token,
    },
    body: JSON.stringify(body),
  });

  if (!hatchResponse.ok) {
    if (hatchResponse.status === 403) {
      throw new Error(
        "Access denied. You may not have permission to create platform assistants.",
      );
    }
    if (hatchResponse.status === 402) {
      throw new Error(
        "Organization balance depleted. Please add funds to continue.",
      );
    }
    throw new Error(
      `Platform hatch failed: ${hatchResponse.status} ${hatchResponse.statusText}`,
    );
  }

  const assistant = (await hatchResponse.json()) as HatchResponse;
  const assistantName = assistant.name;

  console.log(`   Name: ${assistantName}`);
  console.log(`   ID: ${assistant.id}`);
  console.log(`   Status: ${assistant.status}`);
  console.log("");

  // Poll until ACTIVE
  console.log("\u23f3 Waiting for assistant to become active...\n");
  const startTime = Date.now();

  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const statusResponse = await fetch(
      `${platformUrl}/v1/assistants/${assistant.id}/`,
      {
        headers: { "X-Session-Token": token },
      },
    );

    if (!statusResponse.ok) {
      console.warn(
        `\u26a0\ufe0f  Poll request failed (${statusResponse.status}), retrying...`,
      );
      continue;
    }

    const current = (await statusResponse.json()) as HatchResponse;

    if (current.status === "ACTIVE") {
      const runtimeUrl = `${platformUrl}/v1/assistants/${assistant.id}`;
      const entry: AssistantEntry = {
        assistantId: assistant.id,
        runtimeUrl,
        cloud: "vellum-cloud",
        species,
        hatchedAt: assistant.created,
      };
      saveAssistantEntry(entry);
      setActiveAssistant(assistant.id);

      console.log("\u2728 Your assistant has hatched!\n");
      console.log("Instance details:");
      console.log(`  Name: ${assistantName}`);
      console.log(`  ID: ${assistant.id}`);
      console.log(`  Cloud: Vellum Cloud`);
      console.log("");
      return;
    }
  }

  throw new Error(
    `Timed out waiting for assistant to become active (waited ${Math.round(POLL_TIMEOUT_MS / 1000)}s). ` +
      `Check status at: ${platformUrl}/v1/assistants/${assistant.id}/`,
  );
}
