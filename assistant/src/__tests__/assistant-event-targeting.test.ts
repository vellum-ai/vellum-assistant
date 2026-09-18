/**
 * Tests for `matchesTargeting`, the one targeting check behind live fanout
 * (`AssistantEventHub.publish`) and replay (`getReplayWindow`).
 *
 * The parity block runs every case through both paths and requires them to
 * agree, so a rule added to one path alone fails here.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { AssistantEventEnvelope } from "../api/index.js";
import type { HostProxyCapability, InterfaceId } from "../channels/types.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import type { AssistantEventPublishOptions } from "../runtime/assistant-event-publish-options.js";
import { matchesTargeting } from "../runtime/assistant-event-targeting.js";
import {
  _resetStreamStateForTesting,
  getReplayWindow,
  stampAndBuffer,
} from "../runtime/assistant-stream-state.js";

const CONV = "conv-targeting";

interface ClientIdentity {
  type: "client";
  clientId: string;
  interfaceId: InterfaceId;
  capabilities: HostProxyCapability[];
  actorPrincipalId?: string;
}

const MAC: ClientIdentity = {
  type: "client",
  clientId: "mac-1",
  interfaceId: "macos",
  capabilities: ["host_bash", "host_browser"],
  actorPrincipalId: "principal-g",
};
const WEB: ClientIdentity = {
  type: "client",
  clientId: "web-1",
  interfaceId: "web",
  capabilities: [],
  actorPrincipalId: "principal-g",
};
const OTHER_USER: ClientIdentity = {
  type: "client",
  clientId: "web-2",
  interfaceId: "web",
  capabilities: [],
  actorPrincipalId: "principal-x",
};
const NO_PRINCIPAL: ClientIdentity = {
  type: "client",
  clientId: "legacy-1",
  interfaceId: "web",
  capabilities: [],
};
interface ProcessIdentity {
  type: "process";
}

const PROCESS: ProcessIdentity = { type: "process" };

const SUBSCRIBERS: Array<[string, ClientIdentity | ProcessIdentity]> = [
  ["mac", MAC],
  ["web", WEB],
  ["other user", OTHER_USER],
  ["no principal", NO_PRINCIPAL],
  ["process", PROCESS],
];

/** Each targeting case with the subscribers it must reach, by label. */
const CASES: Array<{
  name: string;
  targeting: AssistantEventPublishOptions | undefined;
  reaches: string[];
}> = [
  {
    name: "untargeted",
    targeting: undefined,
    reaches: ["mac", "web", "other user", "no principal", "process"],
  },
  {
    name: "self-echo exclusion",
    targeting: { excludeClientId: "web-1" },
    reaches: ["mac", "other user", "no principal", "process"],
  },
  {
    name: "interface",
    targeting: { targetInterfaceId: "web" },
    reaches: ["web", "other user", "no principal"],
  },
  {
    name: "principal",
    targeting: { targetActorPrincipalId: "principal-g" },
    reaches: ["mac", "web"],
  },
  {
    name: "client",
    targeting: { targetClientId: "mac-1" },
    reaches: ["mac"],
  },
  {
    name: "capability",
    targeting: { targetCapability: "host_browser" },
    reaches: ["mac"],
  },
  {
    name: "client without the capability",
    targeting: { targetClientId: "web-1", targetCapability: "host_browser" },
    reaches: [],
  },
  {
    name: "principal and interface together",
    targeting: {
      targetActorPrincipalId: "principal-g",
      targetInterfaceId: "web",
    },
    reaches: ["web"],
  },
];

function makeEvent(): AssistantEventEnvelope {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 10)}`,
    conversationId: CONV,
    emittedAt: new Date().toISOString(),
    message: { type: "assistant_text_delta", conversationId: CONV, text: "x" },
  };
}

async function reachedLive(
  targeting: AssistantEventPublishOptions | undefined,
): Promise<string[]> {
  const hub = new AssistantEventHub();
  const reached: string[] = [];
  for (const [label, identity] of SUBSCRIBERS) {
    const callback = () => {
      reached.push(label);
    };
    if (identity.type === "process") {
      hub.subscribe({ type: "process", callback });
    } else {
      hub.subscribe({ ...identity, callback });
    }
  }
  await hub.publish(makeEvent(), targeting);
  return reached.sort();
}

function reachedOnReplay(
  targeting: AssistantEventPublishOptions | undefined,
): string[] {
  _resetStreamStateForTesting();
  stampAndBuffer(makeEvent(), targeting ? { targeting } : undefined);
  return SUBSCRIBERS.filter(
    ([, identity]) => (getReplayWindow(0, identity) ?? []).length > 0,
  )
    .map(([label]) => label)
    .sort();
}

describe("matchesTargeting", () => {
  for (const { name, targeting, reaches } of CASES) {
    test(`${name}: reaches exactly its subscribers`, () => {
      const reached = SUBSCRIBERS.filter(([, identity]) =>
        matchesTargeting(targeting, identity),
      ).map(([label]) => label);
      expect(reached.sort()).toEqual([...reaches].sort());
    });
  }
});

describe("live fanout and replay agree", () => {
  beforeEach(() => {
    _resetStreamStateForTesting();
  });

  for (const { name, targeting, reaches } of CASES) {
    test(`${name}: both paths deliver to the same subscribers`, async () => {
      const expected = [...reaches].sort();
      expect(await reachedLive(targeting)).toEqual(expected);
      expect(reachedOnReplay(targeting)).toEqual(expected);
    });
  }
});
