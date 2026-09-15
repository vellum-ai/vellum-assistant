/**
 * Draws the parameter layout `layoutToolParams` decides: each field a small
 * label above its value, long text as a code block, and larger structure
 * nested under a single rule.
 */

import { Typography } from "@vellumai/design-library";
import type { ReactNode } from "react";

import { CodeBlock } from "@/components/detail-primitives";
import type {
  ToolParamField,
  ToolParamFieldList,
} from "@/domains/chat/utils/tool-param-layout";
import { currentLocale, useTranslation } from "@/i18n";
import { cn } from "@/utils/misc";

function ValueText({ children }: { children: ReactNode }) {
  return (
    <Typography
      variant="body-medium-default"
      as="span"
      className="[overflow-wrap:anywhere] text-[var(--content-default)]"
    >
      {children}
    </Typography>
  );
}

function FieldValue({ field }: { field: ToolParamField }) {
  switch (field.kind) {
    case "text":
      return <ValueText>{field.text}</ValueText>;
    case "code":
      return (
        <div className="mt-1">
          <CodeBlock text={field.text} />
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
  const gap = nested ? "gap-2.5" : "gap-3";

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col",
        gap,
        nested && "mt-1 border-l border-[var(--border-base)] pl-3",
      )}
    >
      <dl className={cn("flex min-w-0 flex-col", gap)}>
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
