import { exec, execOutput } from './step-runner.js';

export interface FirewallRuleSpec {
  name: string;
  direction: 'INGRESS' | 'EGRESS';
  action: 'ALLOW' | 'DENY';
  rules: string;
  sourceRanges?: string;
  destinationRanges?: string;
  targetTags: string;
  description: string;
}

interface FirewallRuleState {
  name: string;
  direction: string;
  allowed: string;
  sourceRanges: string;
  destinationRanges: string;
  targetTags: string;
  description: string;
}

async function describeFirewallRule(
  ruleName: string,
  project: string,
): Promise<FirewallRuleState | null> {
  try {
    const output = await execOutput('gcloud', [
      'compute',
      'firewall-rules',
      'describe',
      ruleName,
      `--project=${project}`,
      '--format=json(name,direction,allowed,sourceRanges,destinationRanges,targetTags,description)',
    ]);
    const parsed = JSON.parse(output);
    const allowed = (parsed.allowed ?? [])
      .map((a: { IPProtocol: string; ports?: string[] }) => {
        const ports = a.ports ?? [];
        if (ports.length === 0) {
          return a.IPProtocol;
        }
        return ports.map((p: string) => `${a.IPProtocol}:${p}`).join(',');
      })
      .filter(Boolean)
      .join(',');
    return {
      name: parsed.name ?? '',
      direction: parsed.direction ?? '',
      allowed,
      sourceRanges: (parsed.sourceRanges ?? []).join(','),
      destinationRanges: (parsed.destinationRanges ?? []).join(','),
      targetTags: (parsed.targetTags ?? []).join(','),
      description: parsed.description ?? '',
    };
  } catch {
    return null;
  }
}

function ruleNeedsUpdate(spec: FirewallRuleSpec, state: FirewallRuleState): boolean {
  return (
    spec.direction !== state.direction ||
    spec.rules !== state.allowed ||
    (spec.sourceRanges ?? '') !== state.sourceRanges ||
    (spec.destinationRanges ?? '') !== state.destinationRanges ||
    spec.targetTags !== state.targetTags ||
    spec.description !== state.description
  );
}

async function createFirewallRule(spec: FirewallRuleSpec, project: string): Promise<void> {
  const args = [
    'compute',
    'firewall-rules',
    'create',
    spec.name,
    `--project=${project}`,
    `--direction=${spec.direction}`,
    `--action=${spec.action}`,
    `--rules=${spec.rules}`,
    `--target-tags=${spec.targetTags}`,
    `--description=${spec.description}`,
  ];
  if (spec.sourceRanges) {
    args.push(`--source-ranges=${spec.sourceRanges}`);
  }
  if (spec.destinationRanges) {
    args.push(`--destination-ranges=${spec.destinationRanges}`);
  }
  await exec('gcloud', args);
}

async function deleteFirewallRule(ruleName: string, project: string): Promise<void> {
  await exec('gcloud', [
    'compute',
    'firewall-rules',
    'delete',
    ruleName,
    `--project=${project}`,
    '--quiet',
  ]);
}

export async function syncFirewallRules(
  desiredRules: FirewallRuleSpec[],
  project: string,
  tag: string,
): Promise<void> {
  let existingNames: string[];
  try {
    const output = await execOutput('gcloud', [
      'compute',
      'firewall-rules',
      'list',
      `--project=${project}`,
      `--filter=targetTags:${tag}`,
      '--format=value(name)',
    ]);
    existingNames = output
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    existingNames = [];
  }

  const desiredNames = new Set(desiredRules.map((r) => r.name));

  for (const existingName of existingNames) {
    if (!desiredNames.has(existingName)) {
      console.log(`   Deleting stale firewall rule: ${existingName}`);
      await deleteFirewallRule(existingName, project);
    }
  }

  for (const spec of desiredRules) {
    const state = await describeFirewallRule(spec.name, project);

    if (!state) {
      console.log(`   Creating firewall rule: ${spec.name}`);
      await createFirewallRule(spec, project);
      continue;
    }

    if (ruleNeedsUpdate(spec, state)) {
      console.log(`   Updating firewall rule: ${spec.name}`);
      await deleteFirewallRule(spec.name, project);
      await createFirewallRule(spec, project);
      continue;
    }

    console.log(`   Firewall rule up to date: ${spec.name}`);
  }
}

export async function instanceExists(
  instanceName: string,
  project: string,
  zone: string,
): Promise<boolean> {
  try {
    await execOutput('gcloud', [
      'compute',
      'instances',
      'describe',
      instanceName,
      `--project=${project}`,
      `--zone=${zone}`,
      '--format=get(name)',
    ]);
    return true;
  } catch {
    return false;
  }
}
