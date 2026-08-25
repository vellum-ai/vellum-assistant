/**
 * Per-key monotonic generations. Every operation claims the next one; async
 * work that started earlier checks `isCurrent` before committing, so the
 * last-issued operation for a key always wins.
 */
export interface GenerationGuard {
  claim(key: string): number;
  isCurrent(key: string, generation: number): boolean;
}

export function createGenerationGuard(): GenerationGuard {
  const generations = new Map<string, number>();
  return {
    claim(key) {
      const generation = (generations.get(key) ?? 0) + 1;
      generations.set(key, generation);
      return generation;
    },
    isCurrent(key, generation) {
      return generations.get(key) === generation;
    },
  };
}
