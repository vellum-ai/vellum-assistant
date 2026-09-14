/**
 * `useExpandedSections` reads storage on render rather than a store slice
 * hydrated by an effect, so the value a component sees on its very first
 * render is the point under test: the Reader below records every render,
 * and the first entry is what the first paint carries.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";

import { clearUserScopedOverrides } from "@/utils/typed-storage";
import {
  channelSectionKey,
  saveExpandedSections,
  useExpandedSections,
} from "@/domains/chat/utils/sidebar-group-collapse-storage";

const KEY = (assistantId: string) =>
  `vellum:sidebar-expanded-sections:${assistantId}`;

afterEach(() => {
  cleanup();
  localStorage.clear();
  clearUserScopedOverrides();
});

function renderReader(assistantId: string | null): string[][] {
  const seen: string[][] = [];
  function Reader() {
    seen.push(useExpandedSections(assistantId));
    return null;
  }
  render(createElement(Reader));
  return seen;
}

describe("useExpandedSections", () => {
  test("a stored expansion is there on the first render, not after an effect", () => {
    localStorage.setItem(KEY("asst-1"), JSON.stringify(["recents"]));

    const seen = renderReader("asst-1");

    expect(seen[0]).toEqual(["recents"]);
  });

  test("reads empty with nothing stored, and for no assistant", () => {
    expect(renderReader("asst-1")[0]).toEqual([]);
    expect(renderReader(null)[0]).toEqual([]);
  });

  test("a save reaches a mounted reader and lands in storage", () => {
    const seen = renderReader("asst-1");

    act(() => {
      saveExpandedSections("asst-1", [channelSectionKey("slack")]);
    });

    expect(seen.at(-1)).toEqual([channelSectionKey("slack")]);
    expect(localStorage.getItem(KEY("asst-1"))).toBe(
      JSON.stringify([channelSectionKey("slack")]),
    );
  });

  test("is keyed per assistant", () => {
    localStorage.setItem(KEY("asst-1"), JSON.stringify(["recents"]));

    expect(renderReader("asst-2")[0]).toEqual([]);
  });
});
