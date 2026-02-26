import { join } from 'node:path';

/** Returns the path to the bundled UPDATES.md template. Extracted for testability. */
export function getTemplatePath(): string {
  return join(import.meta.dirname ?? __dirname, 'templates', 'UPDATES.md');
}
