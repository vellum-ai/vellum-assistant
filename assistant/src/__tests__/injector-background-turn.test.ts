import { beforeEach, describe, expect, mock, test } from "bun:test";

let configBackgroundInjection: string =
  "This is a background turn — your guardian isn't watching. If anything noteworthy comes up, send them a notification so they see it when they're back by invoking the `notifications` skill (`assistant notifications send --message \"...\"`)";

const realLoaderForBackgroundTurnTest = await import("../config/loader.js");
const realGetConfigForBackgroundTurnTest =
  realLoaderForBackgroundTurnTest.getConfig;
mock.module("../config/loader.js", () => ({
  ...realLoaderForBackgroundTurnTest,
  getConfig: () => {
    const real = realGetConfigForBackgroundTurnTest();
    return {
      ...real,
      conversations: {
        ...real.conversations,
        backgroundInjection: configBackgroundInjection,
      },
    };
  },
}));

import {
  DEFAULT_INJECTOR_ORDER,
  defaultInjectors,
} from "../plugins/defaults/memory-retrieval/injectors.js";
import type { Injector, TurnContext } from "../plugins/types.js";

function findInjector(name: string): Injector {
  const injector = defaultInjectors.find(
    (candidate) => candidate.name === name,
  );
  if (!injector) {
    throw new Error(`injector '${name}' not registered`);
  }
  return injector;
}

function makeContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    requestId: "req-test",
    conversationId: "conv-test",
    turnIndex: 0,
    trust: { sourceChannel: "vellum", trustClass: "guardian" },
    ...overrides,
  };
}

const backgroundInjector = findInjector("background-turn");

const DEFAULT_INJECTION_TEXT =
  "This is a background turn — your guardian isn't watching. If anything noteworthy comes up, send them a notification so they see it when they're back by invoking the `notifications` skill (`assistant notifications send --message \"...\"`)";

describe("background-turn injector", () => {
  beforeEach(() => {
    configBackgroundInjection = DEFAULT_INJECTION_TEXT;
  });

  test("returns null when isBackgroundConversation is false", async () => {
    const result = await backgroundInjector.produce(
      makeContext({
        isBackgroundConversation: false,
        isNonInteractive: true,
      }),
    );
    expect(result).toBeNull();
  });

  test("returns null when isBackgroundConversation is unset", async () => {
    const result = await backgroundInjector.produce(
      makeContext({ isNonInteractive: true }),
    );
    expect(result).toBeNull();
  });

  test("returns null when the guardian is actively connected (interactive turn)", async () => {
    const result = await backgroundInjector.produce(
      makeContext({
        isBackgroundConversation: true,
        isNonInteractive: false,
      }),
    );
    expect(result).toBeNull();
  });

  test("returns null when isNonInteractive is unset", async () => {
    const result = await backgroundInjector.produce(
      makeContext({ isBackgroundConversation: true }),
    );
    expect(result).toBeNull();
  });

  test("wraps configured text in <background_turn> tags when active and non-interactive", async () => {
    const block = await backgroundInjector.produce(
      makeContext({
        isBackgroundConversation: true,
        isNonInteractive: true,
      }),
    );

    expect(block).toEqual({
      id: "background-turn",
      text: `<background_turn>\n${DEFAULT_INJECTION_TEXT}\n</background_turn>`,
      placement: "prepend-user-tail",
    });
    expect(backgroundInjector.order).toBe(
      DEFAULT_INJECTOR_ORDER.backgroundTurn,
    );
  });

  test("returns null when configured text is the empty string", async () => {
    configBackgroundInjection = "";

    const result = await backgroundInjector.produce(
      makeContext({
        isBackgroundConversation: true,
        isNonInteractive: true,
      }),
    );
    expect(result).toBeNull();
  });

  test("uses operator-configured override text verbatim", async () => {
    configBackgroundInjection = "Custom reminder body.";

    const block = await backgroundInjector.produce(
      makeContext({
        isBackgroundConversation: true,
        isNonInteractive: true,
      }),
    );

    expect(block?.text).toBe(
      "<background_turn>\nCustom reminder body.\n</background_turn>",
    );
  });
});
