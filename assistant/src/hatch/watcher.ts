import { SPECIES_CONFIG } from './constants.js';
import type { Species } from './constants.js';
import { execOutput } from './step-runner.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface PollResult {
  lastLine: string | null;
  done: boolean;
  failed: boolean;
}

async function pollInstance(
  instanceName: string,
  project: string,
  zone: string,
): Promise<PollResult> {
  try {
    const remoteCmd =
      'L=$(tail -1 /var/log/startup-script.log 2>/dev/null || true); ' +
      'S=$(systemctl is-active google-startup-scripts.service 2>/dev/null || true); ' +
      'E=$(cat /var/log/startup-error 2>/dev/null || true); ' +
      'printf "%s\\n===HATCH_SEP===\\n%s\\n===HATCH_ERR===\\n%s" "$L" "$S" "$E"';
    const output = await execOutput('gcloud', [
      'compute',
      'ssh',
      instanceName,
      `--project=${project}`,
      `--zone=${zone}`,
      '--quiet',
      '--ssh-flag=-o StrictHostKeyChecking=no',
      '--ssh-flag=-o UserKnownHostsFile=/dev/null',
      '--ssh-flag=-o ConnectTimeout=10',
      '--ssh-flag=-o LogLevel=ERROR',
      `--command=${remoteCmd}`,
    ]);
    const sepIdx = output.indexOf('===HATCH_SEP===');
    if (sepIdx === -1) {
      return { lastLine: output.trim() || null, done: false, failed: false };
    }
    const errIdx = output.indexOf('===HATCH_ERR===');
    const lastLine = output.substring(0, sepIdx).trim() || null;
    const statusEnd = errIdx === -1 ? undefined : errIdx;
    const status = output.substring(sepIdx + '===HATCH_SEP==='.length, statusEnd).trim();
    const errorContent =
      errIdx === -1 ? '' : output.substring(errIdx + '===HATCH_ERR==='.length).trim();
    const done = lastLine !== null && status !== 'active' && status !== 'activating';
    const failed = errorContent.length > 0 || status === 'failed';
    return { lastLine, done, failed };
  } catch {
    return { lastLine: null, done: false, failed: false };
  }
}

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`;
}

function pickMessage(messages: string[], elapsedMs: number): string {
  const idx = Math.floor(elapsedMs / 15000) % messages.length;
  return messages[idx];
}

function getPhaseIcon(hasLogs: boolean, elapsedMs: number, species: Species): string {
  if (!hasLogs) {
    return elapsedMs < 30000 ? '🥚' : '🪺';
  }
  return elapsedMs < 120000 ? '🐣' : SPECIES_CONFIG[species].hatchedEmoji;
}

export async function watchHatching(
  instanceName: string,
  project: string,
  zone: string,
  startTime: number,
  species: Species,
): Promise<boolean> {
  let spinnerIdx = 0;
  let lastLogLine: string | null = null;
  let linesDrawn = 0;
  let finished = false;
  let failed = false;
  let pollInFlight = false;
  let nextPollAt = Date.now() + 15000;

  function draw(): void {
    if (linesDrawn > 0) {
      process.stdout.write(`\x1b[${linesDrawn}A`);
    }

    const elapsed = Date.now() - startTime;

    const hasLogs = lastLogLine !== null;
    const icon = finished
      ? failed
        ? '💀'
        : SPECIES_CONFIG[species].hatchedEmoji
      : getPhaseIcon(hasLogs, elapsed, species);
    const spinner = finished
      ? failed
        ? '✘'
        : '✔'
      : SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length];
    const config = SPECIES_CONFIG[species];
    const message = finished
      ? failed
        ? 'Startup script failed'
        : 'Your assistant has hatched!'
      : hasLogs
        ? lastLogLine!.length > 68
          ? lastLogLine!.substring(0, 65) + '...'
          : lastLogLine!
        : pickMessage(config.waitingMessages, elapsed);
    spinnerIdx++;

    const lines = ['', `   ${icon} ${spinner}  ${message}  ⏱  ${formatElapsed(elapsed)}`, ''];

    for (const line of lines) {
      process.stdout.write(`\x1b[K${line}\n`);
    }
    linesDrawn = lines.length;
  }

  async function poll(): Promise<void> {
    if (pollInFlight || finished) return;
    pollInFlight = true;
    try {
      const result = await pollInstance(instanceName, project, zone);
      if (result.lastLine) {
        lastLogLine = result.lastLine;
      }
      if (result.done) {
        finished = true;
        failed = result.failed;
      }
    } finally {
      pollInFlight = false;
      nextPollAt = Date.now() + 5000;
    }
  }

  return new Promise<boolean>((resolve) => {
    const interval = setInterval(() => {
      if (finished) {
        draw();
        clearInterval(interval);
        resolve(!failed);
        return;
      }

      if (Date.now() >= nextPollAt) {
        poll();
      }

      draw();
    }, 80);

    process.on('SIGINT', () => {
      clearInterval(interval);
      console.log('');
      console.log(`   Detaching. Instance is still running.`);
      console.log(`   Monitor with: vellum hatch logs ${instanceName}`);
      console.log('');
      process.exit(0);
    });
  });
}

export async function checkCurlFailure(
  instanceName: string,
  project: string,
  zone: string,
): Promise<boolean> {
  const INSTALL_SCRIPT_REMOTE_PATH = '/tmp/vellum-install.sh';
  try {
    const output = await execOutput('gcloud', [
      'compute',
      'ssh',
      instanceName,
      `--project=${project}`,
      `--zone=${zone}`,
      '--quiet',
      '--ssh-flag=-o StrictHostKeyChecking=no',
      '--ssh-flag=-o UserKnownHostsFile=/dev/null',
      '--ssh-flag=-o ConnectTimeout=10',
      '--ssh-flag=-o LogLevel=ERROR',
      `--command=test -s ${INSTALL_SCRIPT_REMOTE_PATH} && echo EXISTS || echo MISSING`,
    ]);
    return output.trim() === 'MISSING';
  } catch {
    return false;
  }
}

export async function recoverFromCurlFailure(
  instanceName: string,
  project: string,
  zone: string,
  sshUser: string,
  installScriptPath: string,
): Promise<void> {
  const INSTALL_SCRIPT_REMOTE_PATH = '/tmp/vellum-install.sh';

  console.log('Uploading install script to instance...');
  await execOutput('gcloud', [
    'compute',
    'scp',
    installScriptPath,
    `${instanceName}:${INSTALL_SCRIPT_REMOTE_PATH}`,
    `--zone=${zone}`,
    `--project=${project}`,
  ]);

  console.log('Running install script on instance...');
  await execOutput('gcloud', [
    'compute',
    'ssh',
    `${sshUser}@${instanceName}`,
    `--zone=${zone}`,
    `--project=${project}`,
    `--command=source ${INSTALL_SCRIPT_REMOTE_PATH}`,
  ]);
}
