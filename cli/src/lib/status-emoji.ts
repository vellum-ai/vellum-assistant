export function statusEmoji(status: string): string {
  const s = status.toLowerCase();
  if (s === "running" || s === "healthy" || s === "ok" || s.startsWith("up ")) {
    return "🟢";
  }
  if (s.startsWith("error") || s === "unreachable" || s.startsWith("exited")) {
    return "🔴";
  }
  if (s === "sleeping") {
    return "💤";
  }
  return "🟡";
}

export function withStatusEmoji(status: string): string {
  return `${statusEmoji(status)} ${status}`;
}
