/**
 * Swap the host's reported languages for the span of one test.
 *
 * Both `navigator.languages` (the ordered preference list `systemLocales()`
 * reads) and `navigator.language` (its single-entry fallback) are replaced, so
 * a test sees the given tag whichever one the code under test reaches for.
 *
 * Property descriptors rather than a module mock: bun applies `mock.module`
 * process-wide, so a stub of `navigator` would follow every other test file
 * sharing the process. Returns the restore, which puts back whatever
 * descriptors were there (including none at all).
 */
export function stubHostLanguage(tag: string): () => void {
  const restores = [
    stubNavigatorProperty("language", tag),
    stubNavigatorProperty("languages", [tag]),
  ];
  return () => {
    for (const restore of restores) {
      restore();
    }
  };
}

function stubNavigatorProperty(name: string, value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, name);
  Object.defineProperty(navigator, name, { value, configurable: true });
  return () => {
    if (original) {
      Object.defineProperty(navigator, name, original);
    } else {
      delete (navigator as unknown as Record<string, unknown>)[name];
    }
  };
}
