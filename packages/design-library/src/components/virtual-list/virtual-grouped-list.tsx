import { ChevronDown, type LucideIcon } from "lucide-react";
import {
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Key,
  type ReactNode,
  type Ref,
} from "react";
import {
  GroupedVirtuoso,
  type Components,
  type ContextProp,
  type GroupedVirtuosoHandle,
  type GroupProps,
} from "react-virtuoso";

import { cn } from "../../utils/cn";

/**
 * Virtualized grouped-list primitive — a wrapper over `react-virtuoso`'s
 * `GroupedVirtuoso` that renders sticky section headers over a virtualized
 * stream of items.
 *
 * Groups are described declaratively via {@link VirtualListGroup}. Collapse
 * state is owned internally: a group seeds from its `defaultCollapsed` flag
 * and is toggled either by the user (through the `toggle` callback handed to
 * `groupHeader`) or programmatically through the {@link
 * VirtualGroupedListHandle} (`collapseGroup`/`expandGroup`, e.g. to force a
 * collapsed group open). A collapsed group contributes zero items to the
 * virtual list, so its rows are fully unmounted rather than merely hidden.
 */
export interface VirtualListGroup<T> {
  key: string;
  label: string;
  icon?: LucideIcon;
  items: T[];
  collapsible?: boolean;
  defaultCollapsed?: boolean;
}

export interface VirtualGroupedListProps<T> {
  groups: VirtualListGroup<T>[];
  /** Render function for each item. `index` is the flat index across all
   *  currently-visible items (collapsed groups contribute none). */
  itemContent: (index: number, item: T, groupKey: string) => ReactNode;
  /** Custom group header. Receives the group, its collapsed state, and a
   *  toggle. Falls back to a default header when omitted. */
  groupHeader?: (
    group: VirtualListGroup<T>,
    collapsed: boolean,
    toggle: () => void,
  ) => ReactNode;
  /** Stable key for each item. Also used to resolve `selectedItemKey`. */
  computeItemKey?: (index: number, item: T) => Key;
  /** Whether group headers stick to the top while scrolling. Default true. */
  stickyHeaders?: boolean;
  /** Key of the selected item; the list opens scrolled to it on mount
   *  (requires `computeItemKey`). */
  selectedItemKey?: string;
  overscan?: number;
  className?: string;
  ref?: Ref<VirtualGroupedListHandle>;
}

export interface VirtualGroupedListHandle {
  scrollToIndex(opts: { index: number; behavior?: "auto" | "smooth" }): void;
  collapseGroup(groupKey: string): void;
  expandGroup(groupKey: string): void;
  getScrollElement(): HTMLElement | null;
}

/**
 * Resolve a group's collapsed state: a non-collapsible group is never
 * collapsed; otherwise an explicit user/programmatic override wins, falling
 * back to the group's `defaultCollapsed` seed. Tracking overrides separately
 * from the seed keeps newly-added groups honouring their own default until
 * the user touches them.
 */
export function isGroupCollapsed<T>(
  group: VirtualListGroup<T>,
  overrides: Record<string, boolean>,
): boolean {
  if (!group.collapsible) return false;
  return overrides[group.key] ?? Boolean(group.defaultCollapsed);
}

/**
 * The flattened representation `GroupedVirtuoso` consumes: a `groupCounts`
 * array (one entry per group, 0 for a collapsed group) plus parallel
 * `flatItems`/`flatGroupKeys` arrays indexed by the flat item index virtuoso
 * passes to `itemContent`/`computeItemKey`. Collapsed groups contribute a 0
 * count and none of their items, keeping the flat index space in lock-step
 * with what virtuoso renders.
 */
export interface GroupModel<T> {
  flatItems: T[];
  flatGroupKeys: string[];
  groupCounts: number[];
}

export function buildGroupModel<T>(
  groups: VirtualListGroup<T>[],
  overrides: Record<string, boolean>,
): GroupModel<T> {
  const flatItems: T[] = [];
  const flatGroupKeys: string[] = [];
  const groupCounts: number[] = [];
  for (const group of groups) {
    if (isGroupCollapsed(group, overrides)) {
      groupCounts.push(0);
      continue;
    }
    groupCounts.push(group.items.length);
    for (const item of group.items) {
      flatItems.push(item);
      flatGroupKeys.push(group.key);
    }
  }
  return { flatItems, flatGroupKeys, groupCounts };
}

/**
 * Group header used when no `groupHeader` render prop is supplied. Renders a
 * label (with optional icon); collapsible groups render as a button with a
 * rotating chevron so the whole header row is the toggle target.
 */
export function DefaultGroupHeader<T>({
  group,
  collapsed,
  toggle,
}: {
  group: VirtualListGroup<T>;
  collapsed: boolean;
  toggle: () => void;
}) {
  const Icon = group.icon;
  const inner = (
    <>
      {Icon ? (
        <Icon
          size={14}
          aria-hidden
          className="shrink-0 text-[color:var(--content-tertiary)]"
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
      {group.collapsible ? (
        <ChevronDown
          size={14}
          aria-hidden
          className={cn(
            "shrink-0 text-[color:var(--content-tertiary)] transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      ) : null}
    </>
  );

  const chrome = cn(
    "flex items-center gap-2 px-3 py-1.5",
    "bg-[var(--surface-base)] text-body-small-default text-[color:var(--content-tertiary)]",
  );

  if (group.collapsible) {
    return (
      <button
        type="button"
        data-slot="virtual-grouped-list-header"
        onClick={toggle}
        aria-expanded={!collapsed}
        className={cn(chrome, "w-full cursor-pointer")}
      >
        {inner}
      </button>
    );
  }

  return (
    <div data-slot="virtual-grouped-list-header" className={chrome}>
      {inner}
    </div>
  );
}

/**
 * Non-sticky replacement for virtuoso's default group wrapper, swapped in
 * when `stickyHeaders` is false. Forwards every attribute virtuoso applies to
 * the group element (`data-index`, `data-item-index`, `data-known-size`, and
 * any role/aria/styling props) so measurement and index tracking keep
 * working, overriding only `position` to `static` so headers scroll away with
 * their items. `context` is stripped so it never lands on the DOM node.
 */
export function NonStickyGroup({
  context: _context,
  style,
  ...rest
}: GroupProps & ContextProp<unknown>) {
  return <div {...rest} style={{ ...style, position: "static" }} />;
}

export function VirtualGroupedList<T>({
  groups,
  itemContent,
  groupHeader,
  computeItemKey,
  stickyHeaders = true,
  selectedItemKey,
  overscan,
  className,
  ref,
}: VirtualGroupedListProps<T>) {
  const virtuosoRef = useRef<GroupedVirtuosoHandle>(null);
  const scrollElementRef = useRef<HTMLElement | null>(null);

  // Explicit collapse overrides keyed by group key; absence means "use the
  // group's defaultCollapsed seed".
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  // Flatten the groups into the parallel arrays virtuoso needs, honouring
  // the current collapse overrides.
  const model = useMemo(
    () => buildGroupModel(groups, overrides),
    [groups, overrides],
  );

  const toggleGroup = useCallback(
    (groupKey: string) => {
      setOverrides((prev) => {
        const group = groups.find((g) => g.key === groupKey);
        if (!group?.collapsible) return prev;
        return { ...prev, [groupKey]: !isGroupCollapsed(group, prev) };
      });
    },
    [groups],
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex({ index, behavior }) {
        virtuosoRef.current?.scrollToIndex({ index, behavior });
      },
      collapseGroup(groupKey) {
        setOverrides((prev) => ({ ...prev, [groupKey]: true }));
      },
      expandGroup(groupKey) {
        setOverrides((prev) => ({ ...prev, [groupKey]: false }));
      },
      getScrollElement() {
        return scrollElementRef.current;
      },
    }),
    [],
  );

  const renderItem = useCallback(
    (index: number) => {
      if (index < 0 || index >= model.flatItems.length) return null;
      return itemContent(index, model.flatItems[index], model.flatGroupKeys[index]);
    },
    [model, itemContent],
  );

  const renderGroup = useCallback(
    (groupIndex: number) => {
      const group = groups[groupIndex];
      if (!group) return null;
      const collapsed = isGroupCollapsed(group, overrides);
      const toggle = () => toggleGroup(group.key);
      if (groupHeader) return groupHeader(group, collapsed, toggle);
      return (
        <DefaultGroupHeader group={group} collapsed={collapsed} toggle={toggle} />
      );
    },
    [groups, overrides, groupHeader, toggleGroup],
  );

  const resolvedComputeItemKey = useMemo(() => {
    if (!computeItemKey) return undefined;
    return (index: number) => {
      if (index < 0 || index >= model.flatItems.length) return index;
      return computeItemKey(index, model.flatItems[index]);
    };
  }, [computeItemKey, model]);

  // When a selected key is known, open the list scrolled to that item.
  // Virtuoso only reads this on mount, so later selection changes are the
  // caller's job (via the handle) and never cause a surprise scroll.
  const initialTopMostItemIndex = useMemo(() => {
    if (selectedItemKey === undefined || !computeItemKey) return undefined;
    const index = model.flatItems.findIndex(
      (item, i) => computeItemKey(i, item) === selectedItemKey,
    );
    return index >= 0 ? index : undefined;
    // Only the initial value matters; recomputing on model changes is inert.
  }, [selectedItemKey, computeItemKey, model]);

  const components = useMemo<Components<T>>(
    () => (stickyHeaders ? {} : { Group: NonStickyGroup }),
    [stickyHeaders],
  );

  return (
    <GroupedVirtuoso<T>
      ref={virtuosoRef}
      data-slot="virtual-grouped-list"
      className={cn("bg-[var(--surface-base)]", className)}
      groupCounts={model.groupCounts}
      groupContent={renderGroup}
      itemContent={renderItem}
      computeItemKey={resolvedComputeItemKey}
      components={components}
      overscan={overscan}
      initialTopMostItemIndex={initialTopMostItemIndex}
      scrollerRef={(el) => {
        // `nodeType` distinguishes a real Element from a Window without
        // referencing the `Window` global.
        scrollElementRef.current = el && "nodeType" in el ? el : null;
      }}
    />
  );
}
