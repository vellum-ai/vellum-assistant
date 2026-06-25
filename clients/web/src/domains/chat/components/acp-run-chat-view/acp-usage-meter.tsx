import { Typography } from "@vellumai/design-library";

import { type AcpRunEntry } from "@/domains/chat/acp-run-store";

const TOKEN_FORMAT = new Intl.NumberFormat("en-US");

interface MeterStatProps {
  label: string;
  value: number;
}

function MeterStat({ label, value }: MeterStatProps) {
  return (
    <div className="flex items-baseline gap-1" data-usage-stat={label.toLowerCase()}>
      <Typography
        variant="label-small-default"
        className="text-[var(--content-tertiary)]"
      >
        {label}
      </Typography>
      <Typography
        variant="body-small-default"
        className="text-[var(--content-secondary)] tabular-nums"
      >
        {TOKEN_FORMAT.format(value)}
      </Typography>
    </div>
  );
}

/**
 * Presentational meter for an ACP run's cumulative token usage. Renders the
 * Input, Output, and Total token counts (thousands-separated) for the chat
 * view header. Renders nothing when neither input nor output is known (older
 * daemons / pre-migration rows). No cost, no context-window gauge.
 */
export function AcpUsageMeter({ entry }: { entry: AcpRunEntry }) {
  const { inputTokens, outputTokens } = entry;
  if (inputTokens === undefined && outputTokens === undefined) return null;

  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;

  return (
    <div className="flex items-center gap-3" data-testid="acp-usage-meter">
      <MeterStat label="Input" value={input} />
      <MeterStat label="Output" value={output} />
      <MeterStat label="Total" value={input + output} />
    </div>
  );
}
