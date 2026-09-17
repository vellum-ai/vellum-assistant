import { createContext, useContext, type ComponentProps } from "react";

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
 */

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
   * arbitrates horizontal gestures marks it here.
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
  return (
    <TableContext.Provider value={{ density, inset, dividers }}>
      <div
        {...containerProps}
        data-slot="table-container"
        className={cn(
          "relative w-full overflow-x-auto",
          containerProps?.className,
        )}
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
