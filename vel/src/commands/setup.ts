import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';

import { exec, execOutput, runSteps } from '../lib/step-runner';

export async function setup(): Promise<void> {
  console.log('\n🔧 vel setup\n');

  const repoRoot = join(import.meta.dir, '..', '..', '..');
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
      name: 'Setting up Claude Code commands',
      run: async () => {
        const commandsSource = join(repoRoot, 'scripts', 'commands');
        const commandsDest = join(repoRoot, '.claude', 'commands');

        mkdirSync(commandsDest, { recursive: true });

        const files = readdirSync(commandsSource).filter((f) =>
          f.endsWith('.md')
        );

        for (const file of files) {
          const linkPath = join(commandsDest, file);
          const target = join('..', '..', 'scripts', 'commands', file);

          try {
            lstatSync(linkPath);
            unlinkSync(linkPath);
          } catch {
            // doesn't exist yet, nothing to unlink
          }

          symlinkSync(target, linkPath);
        }

        // Create .private/ tracking files
        const privateDir = join(repoRoot, '.private');
        mkdirSync(privateDir, { recursive: true });

        for (const name of ['TODO.md', 'DONE.md', 'UNREVIEWED_PRS.md']) {
          const filePath = join(privateDir, name);
          if (!existsSync(filePath)) {
            writeFileSync(filePath, '');
          }
        }
      },
    },
  ]);

  console.log('\n✅ Setup complete!\n');
  console.log('Next steps:');
  console.log("  1. Run 'vel help' to see available commands");
  console.log("  2. Run 'vel up' to start the development environment\n");
}
