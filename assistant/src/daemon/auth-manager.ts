/**
 * Manages daemon-level authentication: session token lifecycle,
 * per-socket auth state, and auth timeouts.
 */
import * as net from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { getSessionTokenPath } from '../util/platform.js';
import { hasNoAuthOverride } from './connection-policy.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('auth-manager');

export const AUTH_TIMEOUT_MS = 5_000;

export class AuthManager {
  private sessionToken = '';
  private authenticatedSockets = new Set<net.Socket>();
  private authTimeouts = new Map<net.Socket, ReturnType<typeof setTimeout>>();

  /** Initialize the session token — reuse from disk or generate a new one. */
  initToken(): void {
    const tokenPath = getSessionTokenPath();
    let existingToken: string | null = null;
    try {
      const raw = readFileSync(tokenPath, 'utf-8').trim();
      if (raw.length >= 32) existingToken = raw;
    } catch { /* file doesn't exist yet */ }

    if (existingToken) {
      this.sessionToken = existingToken;
      log.info({ tokenPath }, 'Reusing existing session token');
    } else {
      this.sessionToken = randomBytes(32).toString('hex');
      writeFileSync(tokenPath, this.sessionToken, { mode: 0o600 });
      chmodSync(tokenPath, 0o600);
      log.info({ tokenPath }, 'New session token generated');
    }
  }

  isAuthenticated(socket: net.Socket): boolean {
    return this.authenticatedSockets.has(socket);
  }

  /** Returns true if VELLUM_DAEMON_NOAUTH bypass is active. */
  shouldAutoAuth(): boolean {
    return hasNoAuthOverride();
  }

  markAuthenticated(socket: net.Socket): void {
    this.authenticatedSockets.add(socket);
  }

  /** Validate a token and authenticate the socket. Returns true on success. */
  authenticate(socket: net.Socket, token: string): boolean {
    if (token === this.sessionToken) {
      this.authenticatedSockets.add(socket);
      return true;
    }
    log.warn('Client provided invalid auth token');
    return false;
  }

  /** Start the auth timeout for a newly connected socket. */
  startTimeout(socket: net.Socket, onTimeout: () => void): void {
    const timer = setTimeout(() => {
      if (!this.authenticatedSockets.has(socket)) {
        log.warn('Client failed to authenticate within timeout, disconnecting');
        onTimeout();
      }
    }, AUTH_TIMEOUT_MS);
    this.authTimeouts.set(socket, timer);
  }

  /** Clear the auth timeout (called when the first message arrives). */
  clearTimeout(socket: net.Socket): void {
    const timer = this.authTimeouts.get(socket);
    if (timer) {
      clearTimeout(timer);
      this.authTimeouts.delete(socket);
    }
  }

  /** Remove all auth state for a disconnected socket. */
  cleanupSocket(socket: net.Socket): void {
    this.clearTimeout(socket);
    this.authenticatedSockets.delete(socket);
  }

  /** Tear down all auth state on server stop. */
  cleanupAll(): void {
    for (const timer of this.authTimeouts.values()) {
      clearTimeout(timer);
    }
    this.authTimeouts.clear();
    this.authenticatedSockets.clear();
  }

  /** Iterate over authenticated sockets (for broadcasting). */
  getAuthenticatedSockets(): Set<net.Socket> {
    return this.authenticatedSockets;
  }
}
