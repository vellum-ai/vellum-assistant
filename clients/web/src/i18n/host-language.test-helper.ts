/**
 * Swap the host's reported language for the span of one test.
 *
 * A property descriptor rather than a module mock: bun applies `mock.module`
 * process-wide, so a stub of `navigator` would follow every other test file
 * sharing the process. Returns the restore, which puts back whatever
 * descriptor was there (including none at all).
 */
export function stubHostLanguage(tag: string): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, "language");
  Object.defineProperty(navigator, "language", {
    value: tag,
    configurable: true,
  });
  return () => {
    if (original) {
      Object.defineProperty(navigator, "language", original);
    } else {
      delete (navigator as unknown as { language?: string }).language;
    }
  };
}
