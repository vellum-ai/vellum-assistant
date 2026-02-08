import { spawn } from 'child_process';
import { join } from 'path';

export async function down(): Promise<void> {
  console.log('🛑 vel down - Stopping development environment\n');

  // Get the repository root (two levels up from vel/src/commands/)
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
