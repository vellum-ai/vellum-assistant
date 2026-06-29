import { Typography } from "@vellumai/design-library";

import { type AcpRunEntry } from "@/domains/chat/acp-run-store";
import { formatAcpCost } from "@/domains/chat/utils/format-acp-cost";

const TOKEN_FORMAT = new Intl.NumberFormat("en-US");

interface MeterStatProps {
  label: string;
  value: string;
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
        {value}
      </Typography>
    </div>
  );
}

/**
 * Presentational meter for an ACP run's usage. Renders the Input and Output
 * token counts (thousands-separated) plus the run's actual cost
 * (currency-formatted) when reported. Renders nothing when neither input nor
 * output is known.
 */
export function AcpUsageMeter({ entry }: { entry: AcpRunEntry }) {
  const { inputTokens, outputTokens, costAmount, costCurrency } = entry;
  if (inputTokens === undefined && outputTokens === undefined) return null;

  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  const hasCost = costAmount != null && costCurrency != null;

  return (
    <div className="flex items-center gap-3" data-testid="acp-usage-meter">
      <MeterStat label="Input" value={TOKEN_FORMAT.format(input)} />
      <MeterStat label="Output" value={TOKEN_FORMAT.format(output)} />
      {hasCost && (
        <MeterStat label="Cost" value={formatAcpCost(costAmount, costCurrency)} />
      )}
    </div>
  );
}
