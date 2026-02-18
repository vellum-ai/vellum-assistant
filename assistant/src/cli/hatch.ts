import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { saveAssistantEntry } from '../hatch/assistant-config.js';
import {
  FIREWALL_TAG,
  GATEWAY_PORT,
  GCP_PROJECT,
  VALID_SPECIES,
} from '../hatch/constants.js';
import type { Species } from '../hatch/constants.js';
import type { FirewallRuleSpec } from '../hatch/gcp.js';
import { instanceExists, syncFirewallRules } from '../hatch/gcp.js';
import { generateRandomSuffix } from '../hatch/random-name.js';
import { ensureAnthropicKey } from '../hatch/secrets.js';
import { buildStartupScript } from '../hatch/startup-script.js';
import { exec, execOutput } from '../hatch/step-runner.js';
import { checkCurlFailure, recoverFromCurlFailure, watchHatching } from '../hatch/watcher.js';

const DEFAULT_ZONE = 'us-central1-a';
const MACHINE_TYPE = 'e2-standard-4';
const DEFAULT_SPECIES: Species = 'velly';

const DESIRED_FIREWALL_RULES: FirewallRuleSpec[] = [
  {
    name: 'allow-vellum-assistant-gateway',
    direction: 'INGRESS',
    action: 'ALLOW',
    rules: `tcp:${GATEWAY_PORT}`,
    sourceRanges: '0.0.0.0/0',
    targetTags: FIREWALL_TAG,
    description: `Allow gateway ingress on port ${GATEWAY_PORT} for vellum-assistant instances`,
  },
  {
    name: 'allow-vellum-assistant-egress',
    direction: 'EGRESS',
    action: 'ALLOW',
    rules: 'all',
    destinationRanges: '0.0.0.0/0',
    targetTags: FIREWALL_TAG,
    description: 'Allow all egress traffic for vellum-assistant instances',
  },
];

async function spawnInteractive(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`\"${command} ${args.join(' ')}\" exited with code ${code}`));
    });
  });
}

export function registerHatchCommand(program: Command): void {
  const hatch = program.command('hatch').description('Create and manage assistant instances on GCP');

  hatch
    .command('logs')
    .description('Tail startup logs for a hatched instance')
    .argument('<instanceName>', 'GCP instance name')
    .option('--project <project>', 'GCP project', GCP_PROJECT)
    .option('--zone <zone>', 'GCP zone', DEFAULT_ZONE)
    .action(async (instanceName: string, opts: { project: string; zone: string }) => {
      const remoteCmd =
        "if [ -f /var/log/startup-error ]; then echo '--- startup-error ---'; cat /var/log/startup-error; echo ''; fi; " +
        "echo '--- startup-script.log (tail -f) ---'; tail -n 200 -f /var/log/startup-script.log";

      await spawnInteractive('gcloud', [
        'compute',
        'ssh',
        instanceName,
        `--project=${opts.project}`,
        `--zone=${opts.zone}`,
        '--quiet',
        '--ssh-flag=-o StrictHostKeyChecking=no',
        '--ssh-flag=-o UserKnownHostsFile=/dev/null',
        '--ssh-flag=-o LogLevel=ERROR',
        `--command=${remoteCmd}`,
      ]);
    });

  hatch
    .command('retire')
    .description('Delete a hatched instance')
    .argument('<instanceName>', 'GCP instance name')
    .option('--project <project>', 'GCP project', GCP_PROJECT)
    .option('--zone <zone>', 'GCP zone', DEFAULT_ZONE)
    .action(async (instanceName: string, opts: { project: string; zone: string }) => {
      await exec('gcloud', [
        'compute',
        'instances',
        'delete',
        instanceName,
        `--project=${opts.project}`,
        `--zone=${opts.zone}`,
        '--quiet',
      ]);
      console.log(`Deleted instance ${instanceName}`);
    });

  hatch
    .argument('[species]', `Species to hatch (${VALID_SPECIES.join(', ')})`, DEFAULT_SPECIES)
    .option('-d, --detach', 'Run in detached mode (background)', false)
    .option('--name <name>', 'Custom instance name')
    .action(async (speciesArg: string, opts: { detach: boolean; name?: string }) => {
      const species = speciesArg as Species;
      if (!VALID_SPECIES.includes(species)) {
        console.error(
          `Error: Unknown species '${species}'. Valid options: ${VALID_SPECIES.join(', ')}`,
        );
        process.exit(1);
      }

      const startTime = Date.now();

      try {
        let instanceName: string;

        if (opts.name) {
          instanceName = opts.name;
        } else {
          const suffix = generateRandomSuffix();
          instanceName = `${species}-${suffix}`;
        }

        console.log(`Creating new assistant: ${instanceName}`);
        console.log(`   Species: ${species}`);
        console.log(`   Cloud: GCP`);
        console.log(`   Project: ${GCP_PROJECT}`);
        console.log(`   Zone: ${DEFAULT_ZONE}`);
        console.log(`   Machine type: ${MACHINE_TYPE}`);
        console.log('');

        if (opts.name) {
          if (await instanceExists(opts.name, GCP_PROJECT, DEFAULT_ZONE)) {
            console.error(
              `Error: Instance name '${opts.name}' is already taken. Please choose a different name.`,
            );
            process.exit(1);
          }
        } else {
          while (await instanceExists(instanceName, GCP_PROJECT, DEFAULT_ZONE)) {
            console.log(`Instance name ${instanceName} already exists, generating a new name...`);
            const suffix = generateRandomSuffix();
            instanceName = `${species}-${suffix}`;
          }
        }

        const sshUser = userInfo().username;
        const bearerToken = randomBytes(32).toString('hex');
        await ensureAnthropicKey();
        const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
        if (!anthropicApiKey) {
          console.error(
            'Error: ANTHROPIC_API_KEY could not be fetched from GCP Secret Manager. ' +
              'Set it manually or check your gcloud configuration.',
          );
          process.exit(1);
        }
        const startupScript = buildStartupScript(species, bearerToken, sshUser, anthropicApiKey);
        const startupScriptPath = join(tmpdir(), `${instanceName}-startup.sh`);
        writeFileSync(startupScriptPath, startupScript);

        console.log('Creating instance with startup script...');
        try {
          await exec('gcloud', [
            'compute',
            'instances',
            'create',
            instanceName,
            `--project=${GCP_PROJECT}`,
            `--zone=${DEFAULT_ZONE}`,
            `--machine-type=${MACHINE_TYPE}`,
            '--image-family=debian-11',
            '--image-project=debian-cloud',
            '--boot-disk-size=50GB',
            '--boot-disk-type=pd-standard',
            `--metadata-from-file=startup-script=${startupScriptPath}`,
            `--labels=species=${species},vellum-assistant=true`,
            '--tags=vellum-assistant',
          ]);
        } finally {
          try {
            unlinkSync(startupScriptPath);
          } catch {
            // ignore cleanup errors
          }
        }

        console.log('Syncing firewall rules...');
        await syncFirewallRules(DESIRED_FIREWALL_RULES, GCP_PROJECT, FIREWALL_TAG);

        console.log(`Instance ${instanceName} created successfully\n`);

        let externalIp: string | null = null;
        try {
          const ipOutput = await execOutput('gcloud', [
            'compute',
            'instances',
            'describe',
            instanceName,
            `--project=${GCP_PROJECT}`,
            `--zone=${DEFAULT_ZONE}`,
            '--format=get(networkInterfaces[0].accessConfigs[0].natIP)',
          ]);
          externalIp = ipOutput.trim() || null;
        } catch {
          console.log('Could not retrieve external IP yet (instance may still be starting)');
        }

        const runtimeUrl = externalIp
          ? `http://${externalIp}:${GATEWAY_PORT}`
          : `http://${instanceName}:${GATEWAY_PORT}`;
        saveAssistantEntry({
          assistantId: instanceName,
          runtimeUrl,
          bearerToken,
          project: GCP_PROJECT,
          zone: DEFAULT_ZONE,
          species,
          sshUser,
          hatchedAt: new Date().toISOString(),
        });

        if (opts.detach) {
          console.log('Startup script is running on the instance...');
          console.log('');
          console.log('Assistant is hatching!\n');
          console.log('Instance details:');
          console.log(`  Name: ${instanceName}`);
          console.log(`  Project: ${GCP_PROJECT}`);
          console.log(`  Zone: ${DEFAULT_ZONE}`);
          if (externalIp) {
            console.log(`  External IP: ${externalIp}`);
          }
          console.log(`  Runtime URL: ${runtimeUrl}`);
          console.log('');
          console.log('The startup script is running. To monitor progress:');
          console.log(`  vellum hatch logs ${instanceName}`);
          console.log('');
          console.log('To connect to the instance:');
          console.log(
            `  gcloud compute ssh ${instanceName} --project=${GCP_PROJECT} --zone=${DEFAULT_ZONE}`,
          );
          console.log('');
          console.log('To delete the instance when done:');
          console.log(`  vellum hatch retire ${instanceName}`);
          console.log('');
        } else {
          console.log('   Press Ctrl+C to detach (instance will keep running)');
          console.log('');

          const success = await watchHatching(
            instanceName,
            GCP_PROJECT,
            DEFAULT_ZONE,
            startTime,
            species,
          );

          if (!success) {
            if (
              species === 'velly' &&
              (await checkCurlFailure(instanceName, GCP_PROJECT, DEFAULT_ZONE))
            ) {
              console.log('');
              console.log('Detected install script curl failure, attempting recovery...');
              const installScriptPath = join(import.meta.dir, '..', '..', 'web', 'public', 'install.sh');
              if (existsSync(installScriptPath)) {
                await recoverFromCurlFailure(
                  instanceName,
                  GCP_PROJECT,
                  DEFAULT_ZONE,
                  sshUser,
                  installScriptPath,
                );
                console.log('Recovery successful!');
              } else {
                console.log('Could not find local install script for recovery.');
                console.log(`Expected at: ${installScriptPath}`);
              }
            } else {
              console.log('');
              console.log('To view startup logs:');
              console.log(`  vellum hatch logs ${instanceName}`);
              console.log('');
              console.log('To delete the instance when done:');
              console.log(`  vellum hatch retire ${instanceName}`);
              console.log('');
              process.exit(1);
            }
          }

          console.log('Instance details:');
          console.log(`  Name: ${instanceName}`);
          console.log(`  Project: ${GCP_PROJECT}`);
          console.log(`  Zone: ${DEFAULT_ZONE}`);
          if (externalIp) {
            console.log(`  External IP: ${externalIp}`);
          }
          console.log(`  Runtime URL: ${runtimeUrl}`);
          console.log('');
          console.log('To connect to the instance:');
          console.log(
            `  gcloud compute ssh ${instanceName} --project=${GCP_PROJECT} --zone=${DEFAULT_ZONE}`,
          );
          console.log('');
          console.log('To delete the instance when done:');
          console.log(`  vellum hatch retire ${instanceName}`);
          console.log('');
        }
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
}
