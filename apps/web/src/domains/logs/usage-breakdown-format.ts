import type { UsageGroupBreakdown } from "./usage-types";

import { formatTokens } from "./format";

export function formatBreakdownTokens(group: UsageGroupBreakdown): string {
  return [
    `${formatTokens(group.totalInputTokens)} direct`,
    `${formatTokens(group.totalCacheCreationTokens)} cache created`,
    `${formatTokens(group.totalCacheReadTokens)} cache read`,
    `${formatTokens(group.totalOutputTokens)} out`,
  ].join(" / ");
}

function abbreviateTokenCount(count: number): string {
  if (!Number.isFinite(count) || count === 0) {
    return "0";
  }
  if (count >= 1_000_000 || (count >= 999_950 && count < 1_000_000)) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return count.toLocaleString();
}

export function formatBreakdownTokensShort(
  group: UsageGroupBreakdown,
): string {
  const totalInput =
    group.totalInputTokens +
    group.totalCacheCreationTokens +
    group.totalCacheReadTokens;
  return `${abbreviateTokenCount(totalInput)} in / ${abbreviateTokenCount(group.totalOutputTokens)} out`;
}
