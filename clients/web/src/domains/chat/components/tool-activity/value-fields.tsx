/**
 * Draws the layout `value-layout` decides for a tool's input or output: each
 * field a small label above its value, text with line breaks as a code block,
 * a list of records as a table, and larger structure nested in a bordered
 * group. Any value taller than the fold, whatever its kind, folds behind Show
 * more, and every named value copies from its label.
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
function ValueText({ children }: { children: ReactNode }) {
  return (
    <MachineText
      as="div"
      className="whitespace-pre-wrap [overflow-wrap:anywhere]"
    >
      {children}
    </MachineText>
  );
}

/**
 * A table cell's value. A cell takes the width of its value on one line, up to
 * about the width of the drawer's content, and only past that wraps, at word
 * boundaries. So a table of many columns scrolls sideways instead of shrinking
 * each column until its values break a character at a time; an inline value
 * can wrap anywhere because it has no sideways scroll to fall back on.
 */
function CellText({ children }: { children: string }) {
  return (
    <MachineText
      as="span"
      className="block w-max max-w-xs whitespace-pre-wrap break-words"
    >
      {children}
    </MachineText>
  );
}

/**
 * The sentence for how many children or rows the layout left out, pointing at
 * the raw form that has them all. The caller writes it, because only the
 * caller knows which raw section that is.
 */
type MoreLabel = (count: number) => string;

function MoreCount({ label }: { label: string }) {
  return (
    <Typography
      variant="body-small-default"
      as="p"
      className="text-[var(--content-tertiary)]"
    >
      {label}
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

function FieldValue({
  field,
  moreLabel,
}: {
  field: ValueField;
  moreLabel: MoreLabel;
}) {
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
              renderCell={(text) => <CellText>{text}</CellText>}
            />
          </ClampedContent>
          {field.more > 0 && <MoreCount label={moreLabel(field.more)} />}
        </div>
      );
    case "nested":
      return (
        <ClampedContent>
          <ValueFields
            list={field.fields}
            moreLabel={moreLabel}
            variant="nested"
          />
        </ClampedContent>
      );
  }
}

const VARIANT_CLASSES = {
  section: "gap-3 rounded-lg border border-[var(--border-base)] p-4",
  nested:
    "mt-1 gap-2.5 rounded-lg border border-[var(--border-base)] px-3 py-2.5",
} as const;

interface ValueFieldsProps {
  list: ValueFieldList;
  /** The sentence counting what the layout left out, naming its raw section. */
  moreLabel: MoreLabel;
  /**
   * `section` is the bordered box a whole input or output sits in; `nested`
   * is the group a list or object inside it draws.
   */
  variant?: keyof typeof VARIANT_CLASSES;
}

export function ValueFields({
  list,
  moreLabel,
  variant = "section",
}: ValueFieldsProps) {
  const { t } = useTranslation("chat");
  const gap = variant === "nested" ? "gap-2.5" : "gap-3";
  const named = list.fields.filter((field) => field.label !== "");
  const unnamed = list.fields.filter((field) => field.label === "");

  return (
    <div className={cn("flex min-w-0 flex-col", VARIANT_CLASSES[variant])}>
      {/* A value with no name is a whole output that is a list; its copy is
          the raw output beneath it, so it draws with no label row. */}
      {unnamed.map((field, index) => (
        <div key={index} className="min-w-0">
          <FieldValue field={field} moreLabel={moreLabel} />
        </div>
      ))}
      {named.length > 0 && (
        <dl className={cn("flex min-w-0 flex-col", gap)}>
          {named.map((field) => (
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
                    ariaLabel={t("valueFields.copyValue", {
                      label: field.label,
                    })}
                  />
                </span>
              </dt>
              <dd className="min-w-0">
                <FieldValue field={field} moreLabel={moreLabel} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {list.more > 0 && <MoreCount label={moreLabel(list.more)} />}
    </div>
  );
}
