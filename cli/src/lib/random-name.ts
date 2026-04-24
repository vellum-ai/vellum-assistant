import { customAlphabet } from "nanoid";

const nanoidLower = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);

export const FUN_NAME_SLUGS = [
  "socrates",
  "plato",
  "aristotle",
  "confucius",
  "laozi",
  "seneca",
  "aurelius",
  "hypatia",
  "descartes",
  "spinoza",
  "kant",
  "voltaire",
  "nietzsche",
  "kierkegaard",
  "bach",
  "mozart",
  "beethoven",
  "vivaldi",
  "handel",
  "haydn",
  "chopin",
  "liszt",
  "schubert",
  "brahms",
  "tchaikovsky",
  "debussy",
  "mahler",
  "euclid",
  "archimedes",
  "galileo",
  "newton",
  "kepler",
  "lovelace",
  "curie",
  "darwin",
  "noether",
  "fibonacci",
  "gutenberg",
  "faraday",
  "mendel",
] as const;

function randomElement<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateRandomSuffix(): string {
  return `${randomElement(FUN_NAME_SLUGS)}-${nanoidLower()}`;
}

/**
 * Generate an instance name for a new assistant. Uses the explicit name if
 * provided, otherwise produces `<species>-<name>-<nanoid>`.
 */
export function generateInstanceName(
  species: string,
  explicitName?: string | null,
): string {
  if (explicitName) return explicitName;
  return `${species}-${generateRandomSuffix()}`;
}
