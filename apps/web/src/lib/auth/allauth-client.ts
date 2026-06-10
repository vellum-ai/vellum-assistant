/**
 * Thin adapter around the generated allauth HeyAPI SDK.
 *
 * Normalizes responses into a discriminated union so callers
 * don't have to scatter null-checks across every call site.
 *
 * Reference: https://docs.allauth.org/en/latest/headless/openapi-specification/
 */
import type {
  Authenticated,
  EmailAddress,
  Flow,
  ProviderAccount,
} from "@/generated/auth/types.gen";
import {
  deleteAllauthByClientV1AuthSession,
  getAllauthByClientV1AuthSession,
  getAllauthByClientV1AuthProviderSignup,
  postAllauthByClientV1AuthProviderSignup,
} from "@/generated/auth/sdk.gen";
import { isElectron } from "@/runtime/is-electron";

// Electron authenticates via the session-token header → allauth's "app" client.
// Web/iOS use cookie sessions → the "browser" client.
const allauthClient = (): "app" | "browser" =>
  isElectron() ? "app" : "browser";

export type AllauthResult<T = unknown> =
  | { ok: true; data: T }
  | {
      ok: false;
      status?: number;
      errors: Array<{ code: string; message: string; param?: string }>;
      flows?: Array<Flow>;
    };

export function isConflict(result: AllauthResult): boolean {
  return !result.ok && result.status === 409;
}

function errorResult(
  error: unknown,
  status?: number,
): AllauthResult<never> {
  const err = error as Record<string, unknown> | undefined;
  if (err && Array.isArray(err.errors)) {
    return { ok: false, status, errors: err.errors };
  }
  const data = err?.data as Record<string, unknown> | undefined;
  if (data && Array.isArray(data.flows)) {
    return { ok: false, status, errors: [], flows: data.flows as Array<Flow> };
  }
  return { ok: false, status, errors: [] };
}

export async function getSession(): Promise<AllauthResult<Authenticated>> {
  const { data, error, response } = await getAllauthByClientV1AuthSession({
    path: { client: allauthClient() },
  });

  if (data) {
    return { ok: true, data: data.data };
  }

  return errorResult(error, response?.status);
}

export async function logout(): Promise<AllauthResult> {
  const { data, error, response } =
    await deleteAllauthByClientV1AuthSession({
      path: { client: allauthClient() },
    });

  if (data) {
    return { ok: true, data };
  }

  if (response?.status === 401) {
    return { ok: true, data: {} };
  }

  return errorResult(error, response?.status);
}

export interface ProviderSignupContext {
  account: ProviderAccount;
  user: Authenticated["user"];
  email: Array<EmailAddress>;
}

export async function getProviderSignup(): Promise<
  AllauthResult<ProviderSignupContext>
> {
  const { data, error, response } =
    await getAllauthByClientV1AuthProviderSignup({
      path: { client: allauthClient() },
    });

  if (data) {
    return { ok: true, data: data.data as unknown as ProviderSignupContext };
  }

  return errorResult(error, response?.status);
}

export async function submitProviderSignup({
  email,
  username,
}: {
  email: string;
  username: string;
}): Promise<AllauthResult<Authenticated>> {
  const { data, error, response } =
    await postAllauthByClientV1AuthProviderSignup({
      path: { client: allauthClient() },
      body: { email, username },
    });

  if (data) {
    return { ok: true, data: data.data };
  }

  return errorResult(error, response?.status);
}
