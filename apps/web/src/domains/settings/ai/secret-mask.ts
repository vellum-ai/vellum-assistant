export function maskSecretForDisplay(value: string): string {
  const minHidden = 3;
  const maxVisible = Math.max(1, value.length - minHidden);
  const prefixLen = Math.min(10, maxVisible);
  const suffixLen = Math.min(4, Math.max(0, maxVisible - prefixLen));
  return `${value.slice(0, prefixLen)}...${suffixLen > 0 ? value.slice(-suffixLen) : ""}`;
}
