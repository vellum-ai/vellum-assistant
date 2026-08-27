/**
 * Per-key monotonic generations. Every operation claims the next one; async
 * work that started earlier checks `isCurrent` before committing, so the
 * last-issued operation for a key always wins.
 */
export interface GenerationGuard {
  claim(key: string): number;
  /** The latest generation for `key` without advancing it (0 when none). */
  current(key: string): number;
  isCurrent(key: string, generation: number): boolean;
  /** Supersede every in-flight operation for `key` without starting a new one. */
  invalidate(key: string): void;
}

export function createGenerationGuard(): GenerationGuard {
  const generations = new Map<string, number>();
  const claim = (key: string) => {
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    return generation;
  };
  return {
    claim,
    current(key) {
      return generations.get(key) ?? 0;
    },
    isCurrent(key, generation) {
      return (generations.get(key) ?? 0) === generation;
    },
    invalidate(key) {
      claim(key);
    },
  };
}
