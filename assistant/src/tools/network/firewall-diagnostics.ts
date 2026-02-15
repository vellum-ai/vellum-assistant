import { execSync } from 'node:child_process';
import { isMacOS, isLinux } from '../../util/platform.js';

export interface FirewallRuleSet {
  source: string;
  rules: string;
}

export interface FirewallDiagnostics {
  platform: string;
  available: boolean;
  ruleSets: FirewallRuleSet[];
  error?: string;
}

function tryExec(command: string): string | null {
  try {
    return execSync(command, { stdio: 'pipe', timeout: 10000, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function getMacOSFirewall(): FirewallDiagnostics {
  const ruleSets: FirewallRuleSet[] = [];

  const appFirewall = tryExec('/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate');
  if (appFirewall !== null) {
    ruleSets.push({ source: 'Application Firewall (socketfilterfw)', rules: appFirewall });
  }

  const pfRules = tryExec('sudo pfctl -sr 2>/dev/null');
  if (pfRules !== null && pfRules.length > 0) {
    ruleSets.push({ source: 'Packet Filter (pfctl -sr)', rules: pfRules });
  } else {
    const pfStatus = tryExec('sudo pfctl -s info 2>/dev/null');
    if (pfStatus !== null) {
      ruleSets.push({ source: 'Packet Filter (pfctl -s info)', rules: pfStatus });
    }
  }

  if (ruleSets.length === 0) {
    return { platform: 'macOS', available: false, ruleSets, error: 'Could not query any firewall — may require elevated privileges' };
  }

  return { platform: 'macOS', available: true, ruleSets };
}

function getLinuxFirewall(): FirewallDiagnostics {
  const ruleSets: FirewallRuleSet[] = [];

  const nftRules = tryExec('nft list ruleset 2>/dev/null');
  if (nftRules !== null) {
    ruleSets.push({ source: 'nftables (nft list ruleset)', rules: nftRules || '(empty ruleset)' });
  }

  const iptablesRules = tryExec('iptables -L -n 2>/dev/null');
  if (iptablesRules !== null) {
    ruleSets.push({ source: 'iptables (iptables -L -n)', rules: iptablesRules });
  }

  const ufwStatus = tryExec('ufw status 2>/dev/null');
  if (ufwStatus !== null) {
    ruleSets.push({ source: 'ufw (ufw status)', rules: ufwStatus });
  }

  if (ruleSets.length === 0) {
    return { platform: 'Linux', available: false, ruleSets, error: 'No firewall tools found (checked nft, iptables, ufw)' };
  }

  return { platform: 'Linux', available: true, ruleSets };
}

export function getFirewallDiagnostics(): FirewallDiagnostics {
  if (isMacOS()) {
    return getMacOSFirewall();
  }

  if (isLinux()) {
    return getLinuxFirewall();
  }

  return {
    platform: process.platform,
    available: false,
    ruleSets: [],
    error: `Firewall diagnostics not supported on ${process.platform}`,
  };
}
