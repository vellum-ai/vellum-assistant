import { afterEach, describe, expect, test } from "bun:test";

import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { getHostShell } from "./host-shell.js";

const subscriptions: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const subscription of subscriptions.splice(0)) {
    subscription.dispose();
  }
});

function connectHostBashClient(
  clientId: string,
  interfaceId: "macos" | "windows",
): void {
  subscriptions.push(
    assistantEventHub.subscribe({
      type: "client",
      clientId,
      interfaceId,
      capabilities: ["host_bash"],
      actorPrincipalId: "actor-1",
      callback: () => {},
    }),
  );
}

describe("getHostShell", () => {
  test("uses the explicitly targeted Windows client's shell", () => {
    connectHostBashClient("windows-client", "windows");

    expect(
      getHostShell(
        {
          clientOs: "web",
          transportInterface: "web",
          sourceActorPrincipalId: "actor-1",
        },
        { target_client_id: "windows-client" },
      ),
    ).toBe("powershell");
  });

  test("uses the single same-user Windows client's shell", () => {
    connectHostBashClient("windows-client", "windows");

    expect(
      getHostShell(
        {
          clientOs: "web",
          transportInterface: "web",
          sourceActorPrincipalId: "actor-1",
        },
        {},
      ),
    ).toBe("powershell");
  });

  test("keeps Bash classification for a targeted macOS client", () => {
    connectHostBashClient("mac-client", "macos");

    expect(
      getHostShell(
        {
          clientOs: "web",
          transportInterface: "web",
          sourceActorPrincipalId: "actor-1",
        },
        { target_client_id: "mac-client" },
      ),
    ).toBeUndefined();
  });
});
