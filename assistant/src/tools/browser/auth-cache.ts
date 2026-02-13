import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { getDataDir } from '../../util/platform.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('auth-cache');

const DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AuthSession {
  domain: string;
  authenticatedAt: number; // epoch ms
  expiresAt?: number; // epoch ms, optional
  method: 'jit' | 'stored';
}

/**
 * Normalize a domain for consistent lookup:
 * - lowercase
 * - strip leading "www."
 */
function normalizeDomain(domain: string): string {
  let d = domain.toLowerCase().trim();
  if (d.startsWith('www.')) {
    d = d.slice(4);
  }
  return d;
}

export class AuthSessionCache {
  private sessions: Map<string, AuthSession> = new Map();
  private filePath: string;
  private defaultExpiryMs: number;
  private loaded = false;

  constructor(dataDir?: string, defaultExpiryMs?: number) {
    const base = dataDir ?? getDataDir();
    this.filePath = join(base, 'browser-auth', 'sessions.json');
    this.defaultExpiryMs = defaultExpiryMs ?? DEFAULT_EXPIRY_MS;
  }

  async load(): Promise<void> {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        const entries: AuthSession[] = JSON.parse(raw);
        this.sessions.clear();
        const now = Date.now();
        for (const entry of entries) {
          const key = normalizeDomain(entry.domain);
          // Skip expired sessions during load
          if (entry.expiresAt != null && entry.expiresAt <= now) {
            log.debug({ domain: key }, 'Skipping expired session during load');
            continue;
          }
          this.sessions.set(key, { ...entry, domain: key });
        }
      }
    } catch (err) {
      log.warn({ err }, 'Failed to load auth session cache, starting fresh');
      this.sessions.clear();
    }
    this.loaded = true;
  }

  async save(): Promise<void> {
    try {
      const dir = join(this.filePath, '..');
      mkdirSync(dir, { recursive: true });
      const entries = Array.from(this.sessions.values());
      writeFileSync(this.filePath, JSON.stringify(entries, null, 2), 'utf-8');
    } catch (err) {
      log.warn({ err }, 'Failed to save auth session cache');
    }
  }

  isAuthenticated(domain: string): boolean {
    const key = normalizeDomain(domain);
    const session = this.sessions.get(key);
    if (!session) return false;

    // Check expiry
    if (session.expiresAt != null && session.expiresAt <= Date.now()) {
      this.sessions.delete(key);
      // Fire-and-forget save for cleanup
      void this.save();
      return false;
    }

    return true;
  }

  markAuthenticated(domain: string, method: 'jit' | 'stored'): void {
    const key = normalizeDomain(domain);
    const now = Date.now();
    const session: AuthSession = {
      domain: key,
      authenticatedAt: now,
      expiresAt: now + this.defaultExpiryMs,
      method,
    };
    this.sessions.set(key, session);
    void this.save();
  }

  invalidate(domain: string): void {
    const key = normalizeDomain(domain);
    this.sessions.delete(key);
    void this.save();
  }

  getAll(): AuthSession[] {
    return Array.from(this.sessions.values());
  }
}

// Singleton export
export const authSessionCache = new AuthSessionCache();
