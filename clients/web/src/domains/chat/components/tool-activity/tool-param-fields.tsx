/**
 * Draws the parameter layout `layoutToolParams` decides: each field a small
 * label above its value, long text as a code block, and larger structure
 * nested under a single rule.
 */

import { Typography } from "@vellumai/design-library";

import { CodeBlock } from "@/components/detail-primitives";
import type {
  ToolParamField,
  ToolParamFieldList,
} from "@/domains/chat/utils/tool-param-layout";
import { useTranslation } from "@/i18n";

function FieldValue({ field }: { field: ToolParamField }) {
  switch (field.kind) {
    case "text":
      return (
        <Typography
          variant="body-medium-default"
          as="span"
          className="[overflow-wrap:anywhere] text-[var(--content-default)]"
        >
          {field.text}
        </Typography>
      );
    case "code":
      return (
        <div className="mt-1">
          <CodeBlock text={field.text} />
        </div>
      );
    case "list":
      return (
        <Typography
          variant="body-medium-default"
          as="span"
          className="[overflow-wrap:anywhere] text-[var(--content-default)]"
        >
          {field.items.join(", ")}
        </Typography>
      );
    case "pairs":
      return (
        <span className="flex flex-wrap gap-x-4 gap-y-0.5">
          {field.pairs.map((pair) => (
            <Typography
              key={pair.key}
              variant="body-medium-default"
              as="span"
              className="[overflow-wrap:anywhere] text-[var(--content-default)]"
            >
              <span className="text-[var(--content-tertiary)]">{pair.key}</span>{" "}
              {pair.text}
            </Typography>
          ))}
        </span>
      );
    case "nested":
      return <ToolParamFields list={field.fields} nested />;
  }
}

interface ToolParamFieldsProps {
  list: ToolParamFieldList;
  /** Sets the fields under a rule, for the contents of a list or object. */
  nested?: boolean;
}

export function ToolParamFields({
  list,
  nested = false,
}: ToolParamFieldsProps) {
  const { t } = useTranslation("chat");

  return (
    <div
      className={
        nested
          ? "mt-1 flex min-w-0 flex-col gap-2.5 border-l border-[var(--border-base)] pl-3"
          : "flex min-w-0 flex-col gap-3"
      }
    >
      <dl className="flex min-w-0 flex-col gap-[inherit]">
        {list.fields.map((field) => (
          <div key={field.label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-label-medium-default [overflow-wrap:anywhere] text-[var(--content-tertiary)]">
              {field.label}
            </dt>
            <dd className="min-w-0">
              <FieldValue field={field} />
            </dd>
          </div>
        ))}
      </dl>
      {list.more > 0 && (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[var(--content-tertiary)]"
        >
          {t("toolParamFields.moreCount", { count: list.more })}
        </Typography>
      )}
    </div>
  );
}
