/**
 * Hydrates the active assistant's identity (name + version) into the
 * Zustand `useAssistantIdentityStore` for the whole authenticated app.
 *
 * Mounted in `RootLayout` so identity is populated on every route under
 * `/assistant/*` — chat, settings, logs — not only while a chat route is
 * on screen. Consumers include the chat sidebar header, the
 * intelligence/identity tab, and `useElectronIdentitySync` (which titles
 * the Electron window, tray, and About panel from the store name).
 *
 * Hydration sources, in order: the optimistic onboarding seed
 * (`consumePendingAssistantName`), then the daemon `/identity` fetch via
 * TanStack Query. SSE `identity_changed` refreshes are written to the
 * store directly by `ChatPage` — idempotent with this hook.
 *
 * Lives in top-level `hooks/` (not under `domains/`) because the
 * assistant identity is consumed by multiple domains — chat sidebar,
 * intelligence/identity tab, library, contacts — with no single
 * domain owner. See CONVENTIONS.md → Top-level shared directories.
 *
 * Pattern (server state in TanStack Query, synced into Zustand for
 * cross-component subscriptions) is the same one `useConversationListInit`
 * uses for the conversation list (LUM-1732).
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/queries
 */
import { useEffect, useRef } from "react";
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
}

export function useAssistantIdentityInit({
  assistantId,
  assistantStateKind,
}: UseAssistantIdentityInitParams) {
  // Identity is fetchable whenever the daemon proxy can answer for the
  // assistant — that's true for "active" *and* "self_hosted" (which
  // also renders chat per `shouldRenderChat` in ChatPage). The other
  // lifecycle states (initializing, cleaning_up, retired, error, etc.)
  // can't satisfy the identity endpoint.
  const canFetchIdentity =
    (assistantStateKind === "active" || assistantStateKind === "self_hosted") &&
    Boolean(assistantId);

  const identityQuery = useQuery({
    queryKey: assistantIdentityQueryKey(assistantId),
    queryFn: () => fetchAssistantIdentity(assistantId as string),
    enabled: canFetchIdentity,
    staleTime: 30_000,
  });

  // Clear the store whenever the assistant context changes (tenant
  // switch, logout, lifecycle leaves a fetchable state) so the previous
  // assistant's name doesn't linger if the new assistant's identity
  // fetch returns null (runtime initializing/unreachable).
  const lastWrittenForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!canFetchIdentity) {
      if (lastWrittenForRef.current !== null) {
        useAssistantIdentityStore.getState().clearIdentity();
        lastWrittenForRef.current = null;
      }
      return;
    }
    if (lastWrittenForRef.current !== assistantId) {
      useAssistantIdentityStore.getState().clearIdentity();
      lastWrittenForRef.current = null;
    }
  }, [canFetchIdentity, assistantId]);

  // Seed the store with the user-chosen name from onboarding before the
  // async identity fetch resolves. Declared after the clear effect so
  // React's effect execution order (declaration order) guarantees the
  // clear runs first and this seed survives.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !canFetchIdentity) return;
    seededRef.current = true;
    const optimisticName = consumePendingAssistantName();
    if (!optimisticName) return;
    const { name: current } = useAssistantIdentityStore.getState();
    if (!current) {
      useAssistantIdentityStore
        .getState()
        .setIdentity(optimisticName, null, assistantId);
      lastWrittenForRef.current = assistantId;
    }
  }, [canFetchIdentity, assistantId]);

  useEffect(() => {
    const data = identityQuery.data;
    // `fetchAssistantIdentity` returns null on transient failures
    // (initializing assistant, unreachable runtime). Don't clobber a
    // good cached name with a transient null on the same assistant —
    // cross-assistant clears are handled by the effect above.
    if (!data) return;
    useAssistantIdentityStore.getState().setIdentity(
      data.name ?? null,
      data.version ?? null,
      assistantId,
    );
    lastWrittenForRef.current = assistantId;
  }, [identityQuery.data, assistantId]);
}
