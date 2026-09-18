import {
  createContext,
  useCallback,
  useContext,
  type ComponentProps,
} from "react";

import { scrollEdgeMask, useScrollEdges } from "../hooks/use-scroll-edges";
import { assignRef } from "../utils/assign-ref";
import { cn } from "../utils/cn";

/**
 * Table: semantic table elements with the library's type, spacing and border
 * tokens. Compose them the way the HTML elements compose (`Table` >
 * `TableHeader` / `TableBody` > `TableRow` > `TableHead` / `TableCell`, with
 * an optional `TableCaption`).
 *
 * The root sets the spacing every cell shares (`density`, `inset`) and where
 * the rules go (`dividers`), so a consumer states its layout once instead of
 * repeating padding on each cell. Sorting, selection state and virtualization
 * belong to the consumer; a long list is `VirtualList`'s job.
 *
 * A table wider than its host scrolls sideways in its own container, which
 * fades whichever side has more columns past it and becomes a focusable
 * region, so the columns out of view read as there and a keyboard can scroll
 * to them.
 */

/** How far the container fades at a side with columns past it. */
const EDGE_FADE = 24;

/** Vertical cell padding: 8px, 10px or 12px rows. */
export type TableDensity = "compact" | "default" | "relaxed";

/** Where horizontal rules are drawn. */
export type TableDividers = "rows" | "header" | "none";

interface TableContextValue {
  density: TableDensity;
  inset: boolean;
  dividers: TableDividers;
}

const TableContext = createContext<TableContextValue>({
  density: "default",
  inset: true,
  dividers: "rows",
});

const ROW_PADDING: Record<TableDensity, string> = {
  compact: "py-2",
  default: "py-2.5",
  relaxed: "py-3",
};

/**
 * Horizontal cell padding. Inset cells are padded on both sides, so the table
 * reads as a block with its own gutter. Flush cells start at the table's left
 * edge and gap to the right, so the first column lines up with text above.
 */
function cellPadding({ density, inset }: TableContextValue): string {
  return cn(ROW_PADDING[density], inset ? "px-3" : "pr-4 last:pr-0");
}

export interface TableProps extends ComponentProps<"table"> {
  /** Vertical cell padding. */
  density?: TableDensity;
  /** Padded on both sides (default) or flush with the table's left edge. */
  inset?: boolean;
  /** Rules under every row (default), under the header only, or none. */
  dividers?: TableDividers;
  /** `fixed` sizes columns by their declared widths, not their content. */
  layout?: "auto" | "fixed";
  /**
   * Props for the scroll container the table sits in. It scrolls
   * horizontally when the table is wider than its host, so a host that
   * arbitrates horizontal gestures marks it here. While it scrolls it is a
   * focusable region, which needs a name: pass `aria-label` or
   * `aria-labelledby` here.
   */
  containerProps?: ComponentProps<"div"> & {
    [dataAttribute: `data-${string}`]: string | undefined;
  };
}

export function Table({
  className,
  density = "default",
  inset = true,
  dividers = "rows",
  layout = "auto",
  containerProps,
  ...props
}: TableProps) {
  const { ref: measureRef, edges } =
    useScrollEdges<HTMLDivElement>("horizontal");
  const containerRef = containerProps?.ref;
  const setContainer = useCallback(
    (node: HTMLDivElement | null) => {
      measureRef(node);
      assignRef(containerRef, node);
    },
    [measureRef, containerRef],
  );
  const scrolls = edges.start || edges.end;
  const mask = scrolls ? scrollEdgeMask("horizontal", EDGE_FADE, edges) : null;

  return (
    <TableContext.Provider value={{ density, inset, dividers }}>
      <div
        {...containerProps}
        ref={setContainer}
        data-slot="table-container"
        // A keyboard reaches the columns out of view only through a
        // focusable container, and anything focusable needs a role and name
        // (WCAG 2.1.1 and 4.1.2). Only while it scrolls: a table that fits
        // adds no tab stop. The focus ring is inset because the edge mask
        // clips anything drawn outside the container.
        role={scrolls ? "region" : containerProps?.role}
        tabIndex={scrolls ? 0 : containerProps?.tabIndex}
        className={cn(
          "relative w-full overflow-x-auto outline-none keyboard-focus:ring-2 keyboard-focus:ring-inset keyboard-focus:ring-[var(--ring)]",
          containerProps?.className,
        )}
        style={
          mask
            ? {
                ...containerProps?.style,
                maskImage: mask,
                WebkitMaskImage: mask,
              }
            : containerProps?.style
        }
      >
        <table
          {...props}
          data-slot="table"
          className={cn(
            "w-full caption-bottom text-left text-body-medium-lighter",
            layout === "fixed" && "table-fixed",
            className,
          )}
        />
      </div>
    </TableContext.Provider>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  const { dividers } = useContext(TableContext);
  return (
    <thead
      {...props}
      data-slot="table-header"
      className={cn(
        dividers !== "none" &&
          "[&_tr]:border-b [&_tr]:border-[var(--border-subtle)]",
        className,
      )}
    />
  );
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  const { dividers } = useContext(TableContext);
  return (
    <tbody
      {...props}
      data-slot="table-body"
      className={cn(
        dividers === "rows" &&
          "[&_tr]:border-b [&_tr]:border-[var(--border-base)] [&_tr:last-child]:border-0",
        className,
      )}
    />
  );
}

export interface TableRowProps extends ComponentProps<"tr"> {
  /** The row responds to the pointer: a hand cursor and a hover surface. */
  interactive?: boolean;
  /** The row is selected. Sets `data-state="selected"` for styling hooks. */
  selected?: boolean;
}

export function TableRow({
  className,
  interactive = false,
  selected = false,
  ...props
}: TableRowProps) {
  return (
    <tr
      {...props}
      data-slot="table-row"
      data-state={selected ? "selected" : undefined}
      className={cn(
        "transition-colors",
        interactive && "cursor-pointer hover:bg-[var(--surface-hover)]",
        selected && "bg-[var(--system-positive-weak)]",
        className,
      )}
    />
  );
}

/** Horizontal alignment of a column's header and cells. */
export type TableAlign = "start" | "end";

const ALIGN_CLASS: Record<TableAlign, string> = {
  start: "text-left",
  end: "text-right",
};

// `align` replaces the deprecated HTML attribute of the same name.
export interface TableHeadProps extends Omit<ComponentProps<"th">, "align"> {
  align?: TableAlign;
}

export function TableHead({
  className,
  align = "start",
  ...props
}: TableHeadProps) {
  const context = useContext(TableContext);
  return (
    <th
      {...props}
      data-slot="table-head"
      className={cn(
        "align-middle text-body-small-default text-[var(--content-quiet)]",
        cellPadding(context),
        ALIGN_CLASS[align],
        className,
      )}
    />
  );
}

export interface TableCellProps extends Omit<ComponentProps<"td">, "align"> {
  align?: TableAlign;
}

export function TableCell({
  className,
  align = "start",
  ...props
}: TableCellProps) {
  const context = useContext(TableContext);
  return (
    <td
      {...props}
      data-slot="table-cell"
      className={cn(
        "align-middle text-[var(--content-default)]",
        cellPadding(context),
        ALIGN_CLASS[align],
        className,
      )}
    />
  );
}

export function TableCaption({
  className,
  ...props
}: ComponentProps<"caption">) {
  return (
    <caption
      {...props}
      data-slot="table-caption"
      className={cn(
        "mt-2 text-left text-body-small-default text-[var(--content-quiet)]",
        className,
      )}
    />
  );
}
