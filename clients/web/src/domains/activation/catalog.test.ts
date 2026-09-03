/**
 * The catalog's coupling contract (PLAN section 6), enforced against the data
 * rather than against code.
 *
 * Content is meant to be edited freely: copy, prompts, chips, icons, colors
 * and order all change without a code change. These tests fence in the parts
 * code does rely on, so a content edit that would render a blank row, a
 * missing glyph, an untinted icon, or a dead link fails here instead of in the
 * product.
 */

import { describe, expect, test } from "bun:test";
import * as lucide from "lucide-react";

import {
  ACTIVATION_CAPABILITY_TAGS,
  isKnownCapabilityTag,
} from "@/domains/activation/capabilities";
import {
  ACTIVATION_CATALOG_LIST_IDS,
  ACTIVATION_COLORS,
  getActivationList,
  getActivationListIds,
  readRawActivationTask,
  type RawActivationTask,
} from "@/domains/activation/catalog";
import { ACTIVATION_ICONS } from "@/domains/activation/catalog-icons";
import { ACTIVATION_LIST_IDS } from "@/hooks/use-activation-checklist-flag";
import activationCopy from "@/i18n/locales/en/activation.json";
import activationTasks from "@/i18n/locales/en/activation-tasks.json";
import { VELLUM_DOWNLOADS_URL } from "@/utils/external-urls";

const TASKS = activationTasks.tasks as unknown as Record<
  string,
  RawActivationTask
>;

/** Starters shown before "Show More", per the mock. */
const STARTER_COUNT = 3;
/** The floor the "Your first 30 things" page promises, minus the starters. */
const MIN_ITEM_COUNT = 27;

/** Every string a translator or copy editor can touch. */
function copyStringsOf(task: RawActivationTask): string[] {
  return [
    task.title,
    task.description,
    task.chip,
    task.prompt,
    ...(task.link ? [task.link.label] : []),
  ];
}

describe("activation list contract", () => {
  test("the flag's arms and the catalog's lists are the same set", () => {
    expect([...ACTIVATION_CATALOG_LIST_IDS].sort()).toEqual(
      [...ACTIVATION_LIST_IDS].sort(),
    );
  });

  for (const listId of ACTIVATION_CATALOG_LIST_IDS) {
    describe(listId, () => {
      const { starters, items } = getActivationListIds(listId);

      test("has exactly three starters and enough items", () => {
        expect(starters).toHaveLength(STARTER_COUNT);
        expect(items.length).toBeGreaterThanOrEqual(MIN_ITEM_COUNT);
      });

      test("names no id twice", () => {
        const ids = [...starters, ...items];
        expect(new Set(ids).size).toBe(ids.length);
      });

      test("every id exists in the task pool", () => {
        const missing = [...starters, ...items].filter((id) => !(id in TASKS));
        expect(missing).toEqual([]);
      });

      // Resolution is what the surfaces actually call, so it is asserted
      // rather than inferred from the two checks above.
      test("resolves every id to a task with copy and a glyph", () => {
        const list = getActivationList(listId);
        expect(list.starters).toHaveLength(starters.length);
        expect(list.items).toHaveLength(items.length);
        for (const task of [...list.starters, ...list.items]) {
          expect(task.title.length).toBeGreaterThan(0);
          expect(task.description.length).toBeGreaterThan(0);
          expect(task.chip.length).toBeGreaterThan(0);
          expect(task.prompt.length).toBeGreaterThan(0);
          expect(task.icon).toBeDefined();
        }
      });
    });
  }
});

describe("activation task pool", () => {
  test("every entry reads back through the loader", () => {
    for (const id of Object.keys(TASKS)) {
      expect(readRawActivationTask(id)).not.toBeNull();
    }
  });

  test("every icon name resolves to a lucide export of the same name", () => {
    for (const [id, task] of Object.entries(TASKS)) {
      expect(
        ACTIVATION_ICONS[task.icon],
        `${id} names icon "${task.icon}", which is not in ACTIVATION_ICONS`,
      ).toBeDefined();
    }
    for (const [name, icon] of Object.entries(ACTIVATION_ICONS)) {
      expect(
        icon,
        `ACTIVATION_ICONS.${name} is not the lucide export of that name`,
      ).toBe((lucide as unknown as Record<string, unknown>)[name] as never);
    }
  });

  test("every color is in the palette", () => {
    for (const [id, task] of Object.entries(TASKS)) {
      expect(
        (ACTIVATION_COLORS as readonly string[]).includes(task.color),
        `${id} has color "${task.color}"`,
      ).toBe(true);
    }
  });

  test("every requires tag is one capabilities.ts answers for", () => {
    for (const [id, task] of Object.entries(TASKS)) {
      for (const tag of task.requires ?? []) {
        expect(
          isKnownCapabilityTag(tag),
          `${id} requires "${tag}", which is not in ${ACTIVATION_CAPABILITY_TAGS.join(", ")}`,
        ).toBe(true);
      }
    }
  });

  test("every link is https and carries a label", () => {
    for (const [id, task] of Object.entries(TASKS)) {
      if (!task.link) {
        continue;
      }
      expect(task.link.label.length, `${id} link has no label`).toBeGreaterThan(
        0,
      );
      expect(task.link.url.startsWith("https://"), `${id} link is not https`).toBe(
        true,
      );
    }
  });

  // The downloads page has one owner, so the catalog's copy of it must be the
  // constant's exact value or the loader's repoint silently stops applying.
  test("the desktop download link is the shared downloads URL", () => {
    expect(TASKS["try-computer-use"]?.link?.url).toBe(VELLUM_DOWNLOADS_URL);
  });

  test("no copy uses an em dash or trails whitespace", () => {
    for (const [id, task] of Object.entries(TASKS)) {
      for (const value of copyStringsOf(task)) {
        expect(value.includes("—"), `${id}: "${value}" has an em dash`).toBe(
          false,
        );
        expect(value, `${id} has trailing or leading whitespace`).toBe(
          value.trim(),
        );
      }
    }
  });
});

/**
 * The surface copy is authored ahead of the components that read it (the
 * modal, the pill and the list page land in later PRs), so this pins the key
 * set the plan signed off on. Without it a rename or a deletion between now
 * and then goes unnoticed until a surface renders a raw key path.
 */
describe("activation copy contract", () => {
  test("the catalog exposes exactly the keys the surfaces read", () => {
    const flatten = (value: unknown, prefix = ""): string[] =>
      typeof value === "object" && value !== null
        ? Object.entries(value).flatMap(([key, child]) =>
            flatten(child, prefix ? `${prefix}.${key}` : key),
          )
        : [prefix];

    expect(flatten(activationCopy).sort()).toEqual(
      [
        "welcome.title",
        "welcome.subtitle",
        "welcome.showMore",
        "welcome.showFullList",
        "welcome.later",
        "row.customLabel",
        "row.customPlaceholder",
        "row.working",
        "row.done",
        "row.steps",
        "pill.label",
        "pill.progress",
        "menu.inspirationList",
        "launch.noAssistant",
        "launch.unknownTask",
        "launch.failed",
        "launch.openConversation",
        "page.title",
        "page.loading",
      ].sort(),
    );
  });
});
