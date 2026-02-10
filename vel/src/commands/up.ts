import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

import { execOutput } from '../lib/step-runner';

const GS_PROJECT_ID = 'vellum-nonprod';

const SECRET_NAMES = [
  'ANTHROPIC_API_KEY',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'STRIPE_SECRET_KEY',
] as const;

export async function up(): Promise<void> {
  console.log('🚀 vel up - Starting development environment\n');

  const repoRoot = join(import.meta.dir, '..', '..', '..');
  const webDir = join(repoRoot, 'web');

  try {
    // Step 0: Verify gcloud service account
    console.log('🔐 Verifying gcloud service account...');
    await verifyGcloudAccount();
    console.log('✅ gcloud service account verified\n');

    // Step 1: Ensure correct Node.js version via nvm
    console.log('📌 Ensuring correct Node.js version from .nvmrc...');
    await ensureNodeVersion(repoRoot);
    console.log('✅ Node.js version set\n');

    // Step 2: Pull secrets from GCP Secret Manager
    console.log('🔑 Pulling secrets from GCP Secret Manager...');
    const secrets = await fetchSecrets();
    console.log('✅ Secrets loaded\n');
    // Step 3: Start Docker Compose for postgres
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

    // Step 4: Wait for postgres to be healthy
    console.log('⏳ Waiting for PostgreSQL to be ready...');
    await waitForPostgres(repoRoot);
    console.log('✅ PostgreSQL is ready\n');

    // Step 5: Push schema to database
    console.log('🔄 Pushing database schema...');
    const push = spawn('bunx', ['--bun', 'drizzle-kit', 'push', '--force'], {
      cwd: webDir,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL || 'postgresql://vellum:password@localhost:5432/vellum',
      },
    });

    const NOTICE_BLOCK_RE = /\{\s*\n\s*severity_local:\s*'NOTICE',[\s\S]*?\}\n?/g;

    const filterOutput = (stream: NodeJS.ReadableStream, target: NodeJS.WritableStream) => {
      let buffer = '';
      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
      });
      stream.on('end', () => {
        target.write(buffer.replace(NOTICE_BLOCK_RE, ''));
      });
    };

    filterOutput(push.stdout!, process.stdout);
    filterOutput(push.stderr!, process.stderr);

    await new Promise<void>((resolve, reject) => {
      push.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`drizzle-kit push failed with code ${code}`));
        }
      });
      push.on('error', reject);
    });

    console.log('✅ Database schema pushed\n');

    // Step 6: Start the web dev server
    console.log('🌐 Starting web dev server...');
    console.log('   Web server will run on http://localhost:3000');
    console.log('   Press Ctrl+C to stop\n');

    const webDev = spawn('bun', ['run', 'dev'], {
      cwd: webDir,
      stdio: 'inherit',
      shell: true,
      env: {
        ...process.env,
        ...secrets,
        DATABASE_URL: process.env.DATABASE_URL || 'postgresql://vellum:password@localhost:5432/vellum',
        APP_URL: process.env.APP_URL || 'http://localhost:3000',
        BETTER_AUTH_SECRET: 'localsecretatleast32characterslong',
        BETTER_AUTH_URL: process.env.BETTER_AUTH_URL || 'http://localhost:3000',
        GS_PROJECT_ID: GS_PROJECT_ID,
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

const EXPECTED_ACCOUNT_SUFFIX = `.iam.gserviceaccount.com`;

async function verifyGcloudAccount(): Promise<void> {
  let output: string;
  try {
    output = await execOutput('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']);
  } catch {
    console.error(
      '⚠️  Could not run gcloud auth list. Is gcloud installed?\n' +
      `   Expected an account matching *@${GS_PROJECT_ID}${EXPECTED_ACCOUNT_SUFFIX}\n`
    );
    return;
  }

  const activeAccount = output.trim();

  if (!activeAccount) {
    console.error(
      '⚠️  No active gcloud account found.\n' +
      '   Please authenticate with a service account:\n' +
      `     gcloud auth activate-service-account --key-file=<path-to-key>\n` +
      `   Expected an account matching *@${GS_PROJECT_ID}${EXPECTED_ACCOUNT_SUFFIX}\n`
    );
    return;
  }

  const expectedSuffix = `@${GS_PROJECT_ID}${EXPECTED_ACCOUNT_SUFFIX}`;
  if (!activeAccount.endsWith(expectedSuffix)) {
    console.error(
      `⚠️  Wrong gcloud account active: ${activeAccount}\n` +
      `   Expected an account matching *${expectedSuffix}\n` +
      '   Switch to the correct service account with:\n' +
      `     gcloud auth activate-service-account --key-file=<path-to-key>\n` +
      '   Or switch configurations with:\n' +
      `     gcloud config configurations activate <config-name>\n`
    );
    return;
  }
}

async function fetchSecrets(): Promise<Record<string, string>> {
  const results = await Promise.all(
    SECRET_NAMES.map(async (name) => {
      try {
        const value = await execOutput('gcloud', [
          'secrets', 'versions', 'access', 'latest',
          `--secret=${name}`,
          `--project=${GS_PROJECT_ID}`,
        ]);
        return [name, value] as const;
      } catch {
        console.warn(`⚠️  Failed to fetch secret ${name}, skipping`);
        return null;
      }
    })
  );
  const entries = results.filter((entry): entry is [string, string] => entry !== null);
  return Object.fromEntries(entries);
}

async function ensureNodeVersion(repoRoot: string): Promise<void> {
  const nvmrcPath = join(repoRoot, '.nvmrc');
  if (!existsSync(nvmrcPath)) {
    console.warn('⚠️  No .nvmrc found, skipping nvm setup');
    return;
  }

  const nvmDir = process.env.NVM_DIR || join(process.env.HOME || '', '.nvm');
  const nvmScript = join(nvmDir, 'nvm.sh');

  if (!existsSync(nvmScript)) {
    console.warn('⚠️  nvm not found, skipping Node.js version management');
    return;
  }

  const child = spawn('bash', ['-c', `source "${nvmScript}" && nvm install`], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  await new Promise<void>((resolve, reject) => {
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`nvm install failed with code ${code}`));
      }
    });
    child.on('error', reject);
  });
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
