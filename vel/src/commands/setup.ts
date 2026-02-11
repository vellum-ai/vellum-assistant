import { existsSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
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
      name: 'Symlinking AGENTS.md → CLAUDE.md',
      run: async () => {
        const agentsMd = join(repoRoot, 'AGENTS.md');
        const claudeMd = join(repoRoot, 'CLAUDE.md');

        if (existsSync(claudeMd)) {
          try {
            const target = readlinkSync(claudeMd);
            if (target === 'AGENTS.md') {
              return; // Already correctly symlinked
            }
          } catch {
            // Not a symlink — remove the regular file so we can create the link
          }
          unlinkSync(claudeMd);
        }

        if (!existsSync(agentsMd)) {
          throw new Error('AGENTS.md not found at repo root');
        }

        symlinkSync('AGENTS.md', claudeMd);
      },
    },
    {
      name: 'Creating .private/ tracking files',
      run: async () => {
        const privateDir = join(repoRoot, '.private');
        if (!existsSync(privateDir)) {
          mkdirSync(privateDir, { recursive: true });
        }
        for (const file of ['TODO.md', 'DONE.md', 'UNREVIEWED_PRS.md']) {
          const filePath = join(privateDir, file);
          if (!existsSync(filePath)) {
            writeFileSync(filePath, '');
          }
        }
      },
    },
    {
      name: 'Installing web dependencies',
      run: async () => {
        await exec('bun', ['install'], { cwd: webDir });
      },
    },
  ]);

  console.log('\n✅ Setup complete!\n');
  console.log('Next steps:');
  console.log("  1. Run 'vel help' to see available commands");
  console.log("  2. Run 'vel up' to start the development environment\n");
}
