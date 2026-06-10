/** Join transcript segments with a single space, ignoring blanks. */
export function joinTranscript(a: string, b: string): string {
  return [a.trim(), b.trim()].filter(Boolean).join(" ");
}
