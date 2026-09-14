/**
 * One parameter of a tool call in a detail panel: its key, with the value
 * beside it when short, beneath it when long, and as JSON when structured.
 */

import { Typography } from "@vellumai/design-library";

import { CodeBlock } from "@/components/detail-primitives";
import type { ToolParam } from "@/domains/chat/utils/tool-params";

/**
 * Scalar strings longer than this render in their own wrapped block rather
 * than inline beside the key, so a long prompt or file body stays readable
 * instead of squeezing the label column.
 */
const INLINE_SCALAR_MAX_CHARS = 48;

interface ToolParamRowProps {
  param: ToolParam;
}

export function ToolParamRow({ param }: ToolParamRowProps) {
  const inline =
    param.scalar !== null &&
    param.scalar.length <= INLINE_SCALAR_MAX_CHARS &&
    !param.scalar.includes("\n");

  return (
    <div
      className={
        inline ? "flex items-baseline justify-between gap-4" : "flex flex-col"
      }
    >
      {/* `leading-5` is deliberate: the `body-small-default` token ships
          `line-height: 1`, which clips the descenders on keys like `template`
          and `config`. */}
      <Typography
        variant="body-small-default"
        as="div"
        className="shrink-0 font-mono leading-5 text-[var(--content-tertiary)]"
      >
        {param.key}
      </Typography>
      {param.scalar !== null ? (
        <Typography
          variant="body-medium-default"
          as="div"
          className={
            inline
              ? "min-w-0 truncate text-right text-[var(--content-default)]"
              : "mt-1.5 whitespace-pre-wrap break-words rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] p-3 leading-relaxed text-[var(--content-default)]"
          }
        >
          {param.scalar}
        </Typography>
      ) : (
        <div className="mt-1.5">
          <CodeBlock text={param.json ?? ""} />
        </div>
      )}
    </div>
  );
}
