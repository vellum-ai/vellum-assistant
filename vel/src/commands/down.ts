import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function down(): Promise<void> {
  console.log('🛑 vel down - Stopping development environment\n');

  const repoRoot = join(__dirname, '..', '..', '..');

  try {
    console.log('📦 Stopping Docker Compose services...');
    const composeDown = spawn('docker', ['compose', 'down'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });

    await new Promise<void>((resolve, reject) => {
      composeDown.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`docker compose down failed with code ${code}`));
        }
      });
      composeDown.on('error', reject);
    });

    console.log('✅ Development environment stopped');
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
