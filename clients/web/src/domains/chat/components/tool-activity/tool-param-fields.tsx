/**
 * Draws the parameter layout `layoutValues` decides: each field a small label
 * above its value, text with line breaks as a code block, a list of records as
 * a table, and larger structure nested in a bordered group. A long value folds
 * behind Show more wherever it is drawn, inline or in a cell.
 */

import { Typography } from "@vellumai/design-library";
import type { ReactNode } from "react";

import { CopyButton } from "@/components/copy-button";
import {
  ClampedContent,
  CodePre,
  DetailBlock,
  MachineText,
} from "@/components/detail-primitives";
import {
  DataTable,
  type DataTableColumn,
  type DataTableRow,
} from "@/domains/chat/components/data-table";
import {
  copyText,
  type TableField,
  type ValueField,
  type ValueFieldList,
} from "@/domains/chat/utils/value-layout";
import { currentLocale, useTranslation } from "@/i18n";
import { cn } from "@/utils/misc";

/**
 * An inline value. Set as machine text, the same as a long value's code block,
 * so a value reads the same whatever its length. Whitespace is kept as
 * written: a tool argument such as a path can depend on repeated or edge
 * spaces, which normal collapsing would hide. A block element, so its lines
 * take the machine text's own leading rather than the field's.
 */
function ValueText({
  as = "div",
  children,
}: {
  as?: "div" | "span";
  children: ReactNode;
}) {
  return (
    <MachineText
      as={as}
      className="whitespace-pre-wrap [overflow-wrap:anywhere]"
    >
      {children}
    </MachineText>
  );
}

/** How many children or rows the layout left out, pointing at the raw input. */
function MoreInRawInput({ count }: { count: number }) {
  const { t } = useTranslation("chat");
  return (
    <Typography
      variant="body-small-default"
      as="p"
      className="text-[var(--content-tertiary)]"
    >
      {t("toolParamFields.moreCount", { count })}
    </Typography>
  );
}

/**
 * A table field's columns and rows as `DataTable` props. Columns are keyed by
 * position rather than name, since a `{ columns, rows }` result can name two
 * columns alike.
 */
function tableProps(field: TableField): {
  columns: DataTableColumn[];
  rows: DataTableRow[];
} {
  return {
    columns: field.columns.map((label, index) => ({
      id: String(index),
      label,
    })),
    rows: field.rows.map((cells, index) => ({
      id: String(index),
      cells: Object.fromEntries(cells.map((cell, i) => [String(i), cell])),
    })),
  };
}

function FieldValue({ field }: { field: ValueField }) {
  switch (field.kind) {
    case "text":
      return (
        <ClampedContent>
          <ValueText>{field.text}</ValueText>
        </ClampedContent>
      );
    case "code":
      // Copied from the field's label like every other value, so the block
      // carries no copy button of its own.
      return (
        <div className="mt-1">
          <DetailBlock>
            <CodePre text={field.text} />
          </DetailBlock>
        </div>
      );
    case "list":
      return (
        <ValueText>
          {new Intl.ListFormat(currentLocale(), {
            style: "narrow",
            type: "conjunction",
          }).format(field.items)}
        </ValueText>
      );
    case "pairs":
      return (
        <span className="flex flex-wrap gap-x-4 gap-y-0.5">
          {field.pairs.map((pair) => (
            <ValueText key={pair.key}>
              <span className="text-[var(--content-tertiary)]">{pair.key}</span>{" "}
              {pair.text}
            </ValueText>
          ))}
        </span>
      );
    case "table":
      // The table folds as one value, like a long text or code block does:
      // one Show more for the table, not one per cell.
      return (
        <div className="mt-1 flex min-w-0 flex-col gap-2">
          <ClampedContent>
            <DataTable
              {...tableProps(field)}
              copyable={false}
              renderCell={(text) => <ValueText as="span">{text}</ValueText>}
            />
          </ClampedContent>
          {field.more > 0 && <MoreInRawInput count={field.more} />}
        </div>
      );
    case "nested":
      return (
        <ClampedContent>
          <ToolParamFields list={field.fields} nested />
        </ClampedContent>
      );
  }
}

interface ToolParamFieldsProps {
  list: ValueFieldList;
  /** Draws the fields as a bordered group, for a list or object inside. */
  nested?: boolean;
}

export function ToolParamFields({
  list,
  nested = false,
}: ToolParamFieldsProps) {
  const { t } = useTranslation("chat");
  const gap = nested ? "gap-2.5" : "gap-3";

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col",
        gap,
        nested &&
          "mt-1 rounded-lg border border-[var(--border-base)] px-3 py-2.5",
      )}
    >
      <dl className={cn("flex min-w-0 flex-col", gap)}>
        {list.fields.map((field) => (
          <div
            key={field.label}
            data-reveal-row={field.kind === "nested" ? undefined : ""}
            className="flex min-w-0 flex-col gap-0.5"
          >
            {/* A group's own row is its label line: hovering a field inside
                the group puts every row around it in :hover, which would
                reveal each enclosing group's copy button with the field's. */}
            <dt
              data-reveal-row={field.kind === "nested" ? "" : undefined}
              className="flex min-w-0 items-center justify-between gap-2"
            >
              <span className="text-label-medium-default leading-4 [overflow-wrap:anywhere] text-[var(--content-tertiary)]">
                {field.label}
              </span>
              {/* Every value copies from its label, revealed on hover (and
                  always shown where the device cannot hover), so a field of
                  any shape offers the same control in the same place. */}
              <span data-reveal className="-my-1 flex shrink-0">
                <CopyButton
                  text={() => copyText(field.value)}
                  ariaLabel={t("toolParamFields.copyValue", {
                    label: field.label,
                  })}
                />
              </span>
            </dt>
            <dd className="min-w-0">
              <FieldValue field={field} />
            </dd>
          </div>
        ))}
      </dl>
      {list.more > 0 && <MoreInRawInput count={list.more} />}
    </div>
  );
}
