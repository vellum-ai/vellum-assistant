import "@/lib/account/allauth-heyapi.js";

import type {
  Authenticated,
  EmailAddress,
  Flow,
  ProviderAccount,
  User,
} from "@/generated/auth/types.gen.js";
import {
  deleteAllauthByClientV1AuthSession,
  getAllauthByClientV1AuthProviderSignup,
  getAllauthByClientV1AuthSession,
  postAllauthByClientV1AuthProviderSignup,
} from "@/generated/auth/sdk.gen.js";

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
    path: { client: "browser" },
  });

  if (data) {
    return { ok: true, data: data.data };
  }

  return errorResult(error, response?.status);
}

export async function logout(): Promise<AllauthResult> {
  const { data, error, response } =
    await deleteAllauthByClientV1AuthSession({
      path: { client: "browser" },
    });

  if (data) {
    return { ok: true, data };
  }

  // 401 means already logged out — treat as success
  if (response?.status === 401) {
    return { ok: true, data: {} };
  }

  return errorResult(error, response?.status);
}

// ---------------------------------------------------------------------------
// Provider signup (rare edge case where allauth needs extra info)
// ---------------------------------------------------------------------------

export interface ProviderSignupContext {
  account: ProviderAccount;
  user: User;
  email: EmailAddress[];
}

export async function getProviderSignup(): Promise<
  AllauthResult<ProviderSignupContext>
> {
  const { data, error, response } =
    await getAllauthByClientV1AuthProviderSignup({
      path: { client: "browser" },
    });

  if (data) {
    return { ok: true, data: data.data };
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
      path: { client: "browser" },
      body: { email, username },
    });

  if (data) {
    return { ok: true, data: data.data };
  }

  return errorResult(error, response?.status);
}
