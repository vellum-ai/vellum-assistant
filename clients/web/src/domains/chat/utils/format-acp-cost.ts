/**
 * Currency-aware cost label. A nonzero amount under one cent rounds to `$0.00`
 * under standard 2-fraction-digit currency formatting, under-reporting real
 * spend for short runs — render those as a "less than one cent" form instead.
 */
export function formatAcpCost(amount: number, currency: string): string {
  const format = (value: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
      value,
    );
  if (amount > 0 && amount < 0.01) return `<${format(0.01)}`;
  return format(amount);
}
