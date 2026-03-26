/**
 * Shared catalog text-search helper.
 *
 * Both the CLI `skills search` command and the daemon `searchSkills` handler
 * need case-insensitive substring matching across multiple fields. This module
 * provides a single generic implementation to prevent the two from drifting.
 */

export function filterByQuery<T>(
  items: T[],
  query: string,
  fields: ((item: T) => string)[],
): T[] {
  const lower = query.toLowerCase();
  return items.filter((item) =>
    fields.some((fn) => fn(item).toLowerCase().includes(lower)),
  );
}
