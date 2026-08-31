/**
 * Registry lookup and the inert-by-default contract for an unmapped provider.
 */

import { describe, expect, test } from "bun:test";

import type { WatcherItem } from "../../../watcher/provider-types.js";
import { gmailNormalizer } from "./gmail.js";
import { linearNormalizer } from "./linear.js";
import {
  getNormalizer,
  listNormalizers,
  normalizeWatcherItem,
  registerNormalizer,
} from "./registry.js";
import type { NotificationNormalizer } from "./types.js";

const LINEAR_ITEM: WatcherItem = {
  externalId: "notif-1",
  eventType: "linear_issue_assigned",
  summary: "Linear issue assigned to you in Team One / ENG-1: Ship it",
  payload: {
    issueId: "issue-1",
    issueTitle: "Ship it",
    teamName: "Team One",
  },
  timestamp: 1_700_000_000_000,
};

describe("normalizer registry", () => {
  test("registers the built-in normalizers at module load", () => {
    expect(getNormalizer("linear")).toBe(linearNormalizer);
    expect(getNormalizer("gmail")).toBe(gmailNormalizer);
    expect(listNormalizers()).toContain(linearNormalizer);
    expect(listNormalizers()).toContain(gmailNormalizer);
  });

  test("returns undefined for an unregistered source", () => {
    expect(getNormalizer("pigeon-post")).toBeUndefined();
  });

  test("re-registering a source replaces the previous entry", () => {
    const replacement: NotificationNormalizer = {
      source: "github",
      normalize: () => null,
    };
    const other: NotificationNormalizer = {
      source: "github",
      normalize: () => null,
    };

    registerNormalizer(replacement);
    expect(getNormalizer("github")).toBe(replacement);

    registerNormalizer(other);
    expect(getNormalizer("github")).toBe(other);
    expect(listNormalizers().filter((n) => n.source === "github")).toHaveLength(
      1,
    );
  });
});

describe("normalizeWatcherItem", () => {
  test("round-trips a Linear item through the registered normalizer", () => {
    expect(normalizeWatcherItem("linear", LINEAR_ITEM)).toEqual(
      linearNormalizer.normalize(LINEAR_ITEM),
    );
  });

  test("returns null for a provider with no normalizer", () => {
    expect(normalizeWatcherItem("pigeon-post", LINEAR_ITEM)).toBeNull();
  });
});
