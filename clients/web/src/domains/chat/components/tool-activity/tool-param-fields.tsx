/**
 * Draws the parameter layout `layoutToolParams` decides: each field a small
 * label above its value, long text as a code block, and larger structure
 * nested in a bordered group.
 */

import { Typography } from "@vellumai/design-library";
import type { ReactNode } from "react";

import { CodeBlock, MachineText } from "@/components/detail-primitives";
import type {
  ToolParamField,
  ToolParamFieldList,
} from "@/domains/chat/utils/tool-param-layout";
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
          <div key={field.label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-label-medium-default leading-4 [overflow-wrap:anywhere] text-[var(--content-tertiary)]">
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
