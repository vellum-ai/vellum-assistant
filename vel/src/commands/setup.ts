import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { ensureBunInPath } from '../lib/bun-path.js';
import { exec, execOutput, runSteps } from '../lib/step-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function setup(): Promise<void> {
  ensureBunInPath();
  console.log('\n🔧 vel setup\n');

  const repoRoot = join(__dirname, '..', '..', '..');
  const webDir = join(repoRoot, 'web');
  const legacyComposePath = join(repoRoot, '..', 'vellum', 'docker-compose.yaml');

  await runSteps([
    {
      name: 'Checking for legacy Vellum containers',
      run: async () => {
        if (!existsSync(legacyComposePath)) {
          return;
        }

        const legacyDir = dirname(legacyComposePath);

        let output: string;
        try {
          output = await execOutput(
            'docker',
            ['compose', 'ps', '--format', '{{.Name}}'],
            { cwd: legacyDir }
          );
        } catch {
          return;
        }

        const running = output
          .split('\n')
          .filter((line) => line.trim().length > 0);

        if (running.length === 0) {
          return;
        }

        await exec('docker', ['compose', 'down'], { cwd: legacyDir });
      },
    },
    {
      name: 'Installing web dependencies',
      run: async () => {
        await exec('bun', ['install'], { cwd: webDir });
      },
    },
    {
      name: 'Running database migrations',
      run: async () => {
        await exec('npx', ['drizzle-kit', 'migrate'], {
          cwd: webDir,
          env: {
            ...process.env,
            DATABASE_URL: process.env.DATABASE_URL || 'postgresql://vellum:password@localhost:5432/vellum',
          },
        });
      },
    },
  ]);

  console.log('\n✅ Setup complete!\n');
  console.log('Next steps:');
  console.log("  1. Run 'vel help' to see available commands");
  console.log("  2. Run 'vel up' to start the development environment\n");
}
