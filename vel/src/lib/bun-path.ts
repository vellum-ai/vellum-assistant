import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export function ensureBunInPath(): void {
  const bunBinDir = join(homedir(), '.bun', 'bin');
  if (existsSync(bunBinDir) && !process.env.PATH?.includes(bunBinDir)) {
    process.env.PATH = `${bunBinDir}:${process.env.PATH}`;
  }
}
