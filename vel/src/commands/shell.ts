import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function shell(): Promise<void> {
  const repoRoot = join(__dirname, '..', '..', '..');
  const webDir = join(repoRoot, 'web');
  const shellScript = join(webDir, 'scripts', 'shell.mts');

  const child = spawn('npx', ['tsx', shellScript], {
    cwd: webDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL:
        process.env.DATABASE_URL ||
        'postgresql://vellum:password@localhost:5432/vellum',
    },
  });

  await new Promise<void>((resolve, reject) => {
    child.on('close', (code) => {
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`Shell exited with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}
