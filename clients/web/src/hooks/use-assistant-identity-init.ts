/**
 * Hydrates the active assistant's identity (name + version) into the
 * Zustand `useAssistantIdentityStore` for the whole authenticated app.
 *
 * Mounted in `RootLayout` so identity is populated on every route under
 * `/assistant/*` (chat, settings, logs), not only while a chat route is
 * on screen. Consumers include the chat sidebar header, the
 * intelligence/identity tab, and `useElectronIdentitySync` (which titles
 * the Electron window, tray, and About panel from the store name).
 *
 * Hydration sources, in order: the optimistic onboarding seed
 * (`consumePendingAssistantName`), then the daemon `/identity` fetch via
 * TanStack Query. SSE `identity_changed` refreshes are written to the
 * store directly by `ChatPage`, idempotent with this hook.
 *
 * Lives in top-level `hooks/` (not under `domains/`) because the
 * assistant identity is consumed by multiple domains (chat sidebar,
 * intelligence/identity tab, library, contacts) with no single
 * domain owner. See CONVENTIONS.md → Top-level shared directories.
 *
 * Pattern (server state in TanStack Query, synced into Zustand for
 * cross-component subscriptions) is the same one `useConversationListInit`
 * uses for the conversation list (LUM-1732).
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/queries
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { fetchAssistantIdentity } from "@/assistant/identity";
import { consumePendingAssistantName } from "@/domains/onboarding/prechat";
import { identityGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import type { AssistantState } from "@/assistant/types";

/** Build the generated query key for identity. Exported for invalidation sites. */
export function assistantIdentityQueryKey(assistantId: string | null) {
  return identityGetQueryKey({ path: { assistant_id: assistantId ?? "" } });
}

interface UseAssistantIdentityInitParams {
  assistantId: string | null;
  assistantStateKind: AssistantState["kind"];
  ownerScopeId?: string | null;
}

export function useAssistantIdentityInit({
  assistantId,
  assistantStateKind,
  ownerScopeId,
}: UseAssistantIdentityInitParams) {
  // Identity is fetchable whenever the daemon proxy can answer for the
  // assistant. That's true for "active" *and* "self_hosted" (which
  // also renders chat per `shouldRenderChat` in ChatPage). The other
  // lifecycle states (initializing, cleaning_up, retired, error, etc.)
  // can't satisfy the identity endpoint.
  const canFetchIdentity =
    (assistantStateKind === "active" || assistantStateKind === "self_hosted") &&
    Boolean(assistantId) &&
    (ownerScopeId === undefined || Boolean(ownerScopeId));
  const ownerKey =
    assistantId && (ownerScopeId === undefined || ownerScopeId)
      ? JSON.stringify([ownerScopeId ?? "request-default", assistantId])
      : null;
  const queryKey = assistantIdentityQueryKey(assistantId);

  const identityQuery = useQuery({
    queryKey:
      ownerScopeId === undefined
        ? queryKey
        : [...queryKey, { notificationOwnerScopeId: ownerScopeId }],
    queryFn: () => fetchAssistantIdentity(assistantId as string),
    enabled: canFetchIdentity,
    staleTime: 30_000,
  });

  // Clear the store whenever the assistant context changes (tenant
  // switch, logout, lifecycle leaves a fetchable state) so the previous
  // assistant's name doesn't linger if the new assistant's identity
  // fetch returns null (runtime initializing/unreachable).
  const lastWrittenForRef = useRef<string | null>(null);
  const [scopedNotificationName, setScopedNotificationName] = useState<{
    name: string;
    owner: { scopeId: string; assistantId: string };
  } | null>(null);
  useEffect(() => {
    if (!canFetchIdentity) {
      if (lastWrittenForRef.current !== null) {
        useAssistantIdentityStore.getState().clearIdentity();
        lastWrittenForRef.current = null;
      }
      setScopedNotificationName(null);
      return;
    }
    if (lastWrittenForRef.current !== ownerKey) {
      useAssistantIdentityStore.getState().clearIdentity();
      lastWrittenForRef.current = null;
      setScopedNotificationName(null);
    }
  }, [canFetchIdentity, ownerKey]);

  // Seed the store with the user-chosen name from onboarding before the
  // async identity fetch resolves. Declared after the clear effect so
  // React's effect execution order (declaration order) guarantees the
  // clear runs first and this seed survives.
  const seededForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ownerKey || seededForRef.current === ownerKey || !canFetchIdentity) {
      return;
    }
    seededForRef.current = ownerKey;
    const optimisticName = consumePendingAssistantName();
    if (!optimisticName) {
      return;
    }
    const { name: current } = useAssistantIdentityStore.getState();
    if (!current) {
      lastWrittenForRef.current = ownerKey;
      setScopedNotificationName(
        ownerScopeId && assistantId
          ? {
              name: optimisticName,
              owner: { scopeId: ownerScopeId, assistantId },
            }
          : null,
      );
      useAssistantIdentityStore
        .getState()
        .setIdentity(optimisticName, null, assistantId);
    }
  }, [canFetchIdentity, assistantId, ownerKey, ownerScopeId]);

  useEffect(() => {
    const data = identityQuery.data;
    // `fetchAssistantIdentity` returns null on transient failures
    // (initializing assistant, unreachable runtime). Don't clobber a
    // good cached name with a transient null on the same assistant:
    // cross-assistant clears are handled by the effect above.
    if (!data) {
      return;
    }
    lastWrittenForRef.current = ownerKey;
    setScopedNotificationName(
      data.name && ownerScopeId && assistantId
        ? {
            name: data.name,
            owner: { scopeId: ownerScopeId, assistantId },
          }
        : null,
    );
    useAssistantIdentityStore
      .getState()
      .setIdentity(data.name ?? null, data.version ?? null, assistantId);
  }, [identityQuery.data, assistantId, ownerKey, ownerScopeId]);

  // The fetch has run and produced nothing: it errored, or it resolved to the
  // `null` `fetchAssistantIdentity` returns for an unreachable runtime. The
  // store keeps its (absent) name and version, since a later refetch may still
  // answer, and records the dead end so a consumer that has to decide
  // something can stop waiting. Declared after the write above so a refetch
  // that lands data clears the bit in the same commit that sets the version.
  const identityUnavailable =
    canFetchIdentity && identityQuery.isFetched && !identityQuery.data;
  useEffect(() => {
    if (!identityUnavailable) {
      return;
    }
    useAssistantIdentityStore.getState().markIdentityUnavailable(assistantId);
  }, [identityUnavailable, assistantId]);

  return {
    notificationName:
      assistantId &&
      ownerScopeId &&
      scopedNotificationName?.owner.scopeId === ownerScopeId &&
      scopedNotificationName.owner.assistantId === assistantId
        ? scopedNotificationName
        : null,
  };
}
