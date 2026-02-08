import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { ensureBunInPath } from '../lib/bun-path.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function up(): Promise<void> {
  ensureBunInPath();
  console.log('🚀 vel up - Starting development environment\n');

  const repoRoot = join(__dirname, '..', '..', '..');
  const webDir = join(repoRoot, 'web');

  try {
    // Step 1: Start Docker Compose for postgres
    console.log('📦 Starting PostgreSQL container...');
    const composeUp = spawn('docker', ['compose', 'up', '-d'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });

    await new Promise<void>((resolve, reject) => {
      composeUp.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`docker compose up failed with code ${code}`));
        }
      });
      composeUp.on('error', reject);
    });

    console.log('✅ PostgreSQL container started\n');

    // Step 2: Wait for postgres to be healthy
    console.log('⏳ Waiting for PostgreSQL to be ready...');
    await waitForPostgres(repoRoot);
    console.log('✅ PostgreSQL is ready\n');

    // Step 3: Run database migrations
    console.log('🔄 Running database migrations...');
    const migrate = spawn('npx', ['drizzle-kit', 'migrate'], {
      cwd: webDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL || 'postgresql://vellum:password@localhost:5432/vellum',
      },
    });

    await new Promise<void>((resolve, reject) => {
      migrate.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`drizzle-kit migrate failed with code ${code}`));
        }
      });
      migrate.on('error', reject);
    });

    console.log('✅ Database migrations complete\n');

    // Step 4: Start the web dev server
    console.log('🌐 Starting web dev server...');
    console.log('   Web server will run on http://localhost:3000');
    console.log('   Press Ctrl+C to stop\n');

    const webDev = spawn('bun', ['run', 'dev'], {
      cwd: webDir,
      stdio: 'inherit',
      shell: true,
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL || 'postgresql://vellum:password@localhost:5432/vellum',
        APP_URL: process.env.APP_URL || 'http://localhost:3000',
        MINIO_ENDPOINT: process.env.MINIO_ENDPOINT || 'http://localhost:9000',
        MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY || 'minioadmin',
        MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY || 'minioadmin',
      },
    });

    // Handle graceful shutdown
    const cleanup = async () => {
      console.log('\n\n🛑 Shutting down...');
      webDev.kill();
      console.log('✅ Development environment stopped');
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    webDev.on('close', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`\n❌ Web dev server exited with code ${code}`);
        process.exit(code);
      }
    });

    // Keep the process alive
    await new Promise(() => {});
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function waitForPostgres(repoRoot: string, maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    const healthCheck = spawn(
      'docker',
      ['compose', 'exec', '-T', 'postgres', 'pg_isready', '-U', 'vellum', '-d', 'vellum_assistant'],
      { cwd: repoRoot, stdio: 'pipe' }
    );

    const isReady = await new Promise<boolean>((resolve) => {
      healthCheck.on('close', (code) => resolve(code === 0));
      healthCheck.on('error', () => resolve(false));
    });

    if (isReady) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error('PostgreSQL failed to become ready');
}
