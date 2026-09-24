/**
 * The controls a shared surface offers to be pointed at, cut down to what a
 * prompt can carry.
 *
 * The helper answers `ax.candidates` with every named control it can see on
 * the surface, in screen points and in tree order. That list is the one
 * `ax.locate` resolves a name against, so offering it before the first lookup
 * lets the assistant name a real control on its first try rather than
 * learning the names from a refusal. A web page can carry hundreds, so this
 * keeps the ones worth naming and says how many there were.
 *
 * Pure, so the rules are exercised without a helper or a window server.
 */

import type { ShareTarget, ShareTargetSnapshot } from "@vellumai/ipc-contract";

/** One control as the helper describes it, in screen points. */
export interface HelperShareTarget {
  label: string;
  role: string;
  /** The nearest named container, when the tree has one. */
  section?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The rectangle the shared surface occupies, in the same screen points. */
export interface SurfaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How many controls a snapshot names.
 *
 * Enough to cover a toolbar, a sidebar and a dialog's buttons; each entry is
 * a handful of tokens in every escalated turn that runs while the share is on.
 */
export const SHARE_TARGETS_MAX = 40;

/**
 * The longest name worth offering. The same bound `screen_point_at` puts on
 * a target, so every name offered is one the tool accepts. Past it the text
 * is content being read rather than a control's name.
 */
export const SHARE_TARGET_LABEL_MAX = 120;

/**
 * The smallest side, in points, a control is offered with.
 *
 * Chromium reports collapsed rows and hidden buttons as 1pt tall, stacked at
 * one y, and an arrow aimed at one lands on whatever visible row is above.
 */
export const SHARE_TARGET_MIN_SIDE = 2;

/**
 * Roles a person presses, types into or picks. Offered ahead of static text
 * and containers when the surface has more than {@link SHARE_TARGETS_MAX}.
 */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "AXButton",
  "AXCheckBox",
  "AXCell",
  "AXComboBox",
  "AXDisclosureTriangle",
  "AXIncrementor",
  "AXLink",
  "AXMenuBarItem",
  "AXMenuButton",
  "AXMenuItem",
  "AXPopUpButton",
  "AXRadioButton",
  "AXRow",
  "AXSearchField",
  "AXSegmentedControl",
  "AXSlider",
  "AXTab",
  "AXTextArea",
  "AXTextField",
  "AXToolbarButton",
]);

/** Fractions to three places: a tenth of a percent is finer than any mark. */
const round = (fraction: number): number => Math.round(fraction * 1000) / 1000;

const collapse = (label: string): string => label.split(/\s+/).join(" ").trim();

/**
 * A short id for a control that stays the same while its role and name do:
 * FNV-1a over both, in base 36.
 */
const stableId = (role: string, label: string): string => {
  let hash = 0x811c9dc5;
  for (const char of `${role}\n${label}`) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `t${hash.toString(36)}`;
};

/**
 * The snapshot a set of helper controls makes on `surface`.
 *
 * Kept: named controls at least {@link SHARE_TARGET_MIN_SIDE} points on each
 * side whose middle lies on the surface, with a name no longer than
 * {@link SHARE_TARGET_LABEL_MAX}. A name carried by several controls is
 * offered once with a count, since a lookup by it cannot pick one. Over the
 * cap, interactive roles go first; what is kept stays in tree order.
 *
 * `total` is how many named controls the helper saw, which can exceed the
 * list it sent.
 */
export function buildShareTargetSnapshot(
  elements: readonly HelperShareTarget[],
  surface: SurfaceRect,
  total: number = elements.length,
): ShareTargetSnapshot {
  if (surface.width <= 0 || surface.height <= 0) {
    return { targets: [], total };
  }
  type Kept = Omit<ShareTarget, "id"> & { order: number };
  const byLabel = new Map<string, Kept>();
  elements.forEach((element, order) => {
    const label = collapse(element.label);
    if (label.length === 0 || label.length > SHARE_TARGET_LABEL_MAX) {
      return;
    }
    if (
      element.width < SHARE_TARGET_MIN_SIDE ||
      element.height < SHARE_TARGET_MIN_SIDE
    ) {
      return;
    }
    const x = (element.x - surface.x) / surface.width;
    const y = (element.y - surface.y) / surface.height;
    const width = element.width / surface.width;
    const height = element.height / surface.height;
    const midX = x + width / 2;
    const midY = y + height / 2;
    if (midX < 0 || midX > 1 || midY < 0 || midY > 1) {
      return;
    }
    const seen = byLabel.get(label);
    if (seen !== undefined) {
      seen.duplicates = (seen.duplicates ?? 1) + 1;
      return;
    }
    const section =
      element.section === undefined ? "" : collapse(element.section);
    byLabel.set(label, {
      label,
      role: element.role,
      ...(section.length > 0 ? { section } : {}),
      x: round(x),
      y: round(y),
      width: round(width),
      height: round(height),
      order,
    });
  });

  const kept = [...byLabel.values()];
  const interactive = kept.filter((t) => INTERACTIVE_ROLES.has(t.role));
  const other = kept.filter((t) => !INTERACTIVE_ROLES.has(t.role));
  const chosen = [...interactive, ...other]
    .slice(0, SHARE_TARGETS_MAX)
    .sort((a, b) => a.order - b.order);

  const ids = new Set<string>();
  return {
    targets: chosen.map(({ order: _order, ...target }) => {
      const base = stableId(target.role, target.label);
      let id = base;
      for (let n = 2; ids.has(id); n += 1) {
        id = `${base}-${n}`;
      }
      ids.add(id);
      return { id, ...target };
    }),
    total,
  };
}
