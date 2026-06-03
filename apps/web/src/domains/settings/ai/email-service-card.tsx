import {
  CircleCheck,
  Crown,
  ExternalLink,
  Info,
  Loader2,
  Trash2,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Notice } from "@vellum/design-library/components/notice";
import { DomainField } from "@/domains/settings/components/domain-field";
import { DetailCard } from "@/components/detail-card";
import { toast } from "@vellum/design-library/components/toast";
import {
  assistantsDomainsCreateMutation,
  assistantsDomainsDestroyMutation,
  assistantsDomainsListOptions,
  assistantsDomainsListQueryKey,
  assistantsDomainsVerificationStatusRetrieveOptions,
  assistantsEmailAddressesCreateMutation,
  assistantsEmailAddressesDestroyMutation,
  assistantsEmailAddressesListOptions,
  assistantsEmailAddressesListQueryKey,
  assistantsEmailAddressesStatusRetrieveOptions,
  assistantsEmailAddressesStatusRetrieveQueryKey,
  assistantsListQueryKey,
  organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import { credentialsInspectPost } from "@/generated/daemon/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { useEnvironmentStore } from "@/stores/environment-store";
import { routes } from "@/utils/routes";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import { useAssistantSelectionStore } from "@/assistant/selection-store";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { extractErrorMessage } from "@/utils/api-errors";

import type { ServiceMode, EmailByoProvider } from "@/domains/settings/ai/ai-types";
import {
  EMAIL_BYO_PROVIDERS,
  LS_EMAIL_MODE,
  LS_EMAIL_BYO_PROVIDER,
} from "@/domains/settings/ai/ai-types";
import { DomainVerificationChip, ServiceCard, SaveButton } from "@/domains/settings/ai/ai-shared-ui";

interface EmailServiceCardProps {
  assistantId: string | undefined;
  assistantHandle: string | undefined;
}

export function EmailServiceCard({ assistantId, assistantHandle }: EmailServiceCardProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const emailRootDomain = useEnvironmentStore.use.emailRootDomain();
  const platformGate = usePlatformGate();
  const activeAssistantId = useAssistantSelectionStore.use.activeAssistantId();
  const byoAssistantId = assistantId ?? activeAssistantId;
  const [mode, setMode] = useState<ServiceMode>(
    () => platformGate === "gated" ? "your-own" : getLocalSetting(LS_EMAIL_MODE, "managed") as ServiceMode,
  );
  const [byoProviderId, setByoProviderId] = useState<EmailByoProvider["id"]>(
    () =>
      getLocalSetting(
        LS_EMAIL_BYO_PROVIDER,
        "resend",
      ) as EmailByoProvider["id"],
  );
  const [subdomainDraft, setSubdomainDraft] = useState("");
  const [subdomainPrefilled, setSubdomainPrefilled] = useState(false);
  const [subdomainError, setSubdomainError] = useState<string | null>(null);
  const [usernameDraft, setUsernameDraft] = useState("");
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [savingMode, setSavingMode] = useState(false);
  const [registerConfirmOpen, setRegisterConfirmOpen] = useState(false);
  const [releaseConfirmOpen, setReleaseConfirmOpen] = useState(false);
  const [removeAddressConfirmOpen, setRemoveAddressConfirmOpen] = useState(false);

  // -- BYO credential check (your-own mode) ----------------------------------
  // Use byoAssistantId (lifecycle-backed fallback) so the check works in
  // local/self-hosted mode where the platform assistant list may be empty.
  const byoCredentialQuery = useQuery({
    queryKey: ["byoEmailCredential", byoAssistantId, byoProviderId],
    queryFn: async () => {
      const { data } = await credentialsInspectPost({
        path: { assistant_id: byoAssistantId! },
        body: { service: byoProviderId, field: "api_key" },
        throwOnError: true,
      });
      return data;
    },
    enabled: !!byoAssistantId && mode === "your-own",
    staleTime: 60_000,
    retry: false,
  });
  const byoConfigured = byoCredentialQuery.data?.hasSecret === true;

  useEffect(() => {
    if (subdomainPrefilled || !assistantHandle || subdomainDraft) return;
    setSubdomainDraft(assistantHandle);
    setSubdomainPrefilled(true);
  }, [assistantHandle, subdomainPrefilled, subdomainDraft]);

  // -- Subscription gate (managed mode requires the managed_email entitlement)
  // We read the `managed_email` entitlement directly rather than inferring it
  // from the plan, so an admin `EntitlementOverride` (which flips a Base org to
  // entitled) is honored in-product. We separate "definitely not entitled"
  // from "unknown" so a failed subscription fetch (transient 5xx, network
  // blip) doesn't lock entitled users out of their own managed email. React
  // Query preserves last-known `data` across failed refetches, so
  // `isExplicitlyNotEntitled` only flips true when the server told us so. The
  // backend `assert_entitlement` remains the source of truth — this gate is
  // just a UX hint to keep non-entitled orgs out of a form that would 403
  // anyway.
  const subscriptionQuery = useQuery({
    ...organizationsBillingSubscriptionRetrieveOptions(),
    enabled: mode === "managed" && platformGate === "full",
  });
  const subscriptionData = subscriptionQuery.data;
  const entitlements = subscriptionData?.entitlements;
  const hasManagedEmail = entitlements?.managed_email === true;
  // Only an explicit denial when the server returned an entitlements object that
  // omits managed_email. A successful payload lacking entitlements entirely
  // (older platform deploy / partial response) is treated as unknown and fails
  // open, preserving the definitely-not vs unknown split.
  const isExplicitlyNotEntitled = !!entitlements && !hasManagedEmail;
  const subscriptionUnknown =
    !subscriptionData &&
    subscriptionQuery.isError &&
    !subscriptionQuery.isFetching;

  // -- Domain & address state (managed mode) ---------------------------------
  const domainsQuery = useQuery({
    ...assistantsDomainsListOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: !!assistantId && mode === "managed" && !isExplicitlyNotEntitled && platformGate === "full",
  });
  const addressesQuery = useQuery({
    ...assistantsEmailAddressesListOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: !!assistantId && mode === "managed" && !isExplicitlyNotEntitled && platformGate === "full",
  });

  const domain = domainsQuery.data?.results?.[0];
  const address = addressesQuery.data?.results?.[0];
  const fullDomain = domain ? `${domain.subdomain}.${emailRootDomain}` : null;

  const statusQuery = useQuery({
    ...assistantsEmailAddressesStatusRetrieveOptions({
      path: { assistant_id: assistantId ?? "", id: address?.id ?? "" },
    }),
    enabled: !!assistantId && !!address?.id && mode === "managed" && platformGate === "full",
    refetchOnWindowFocus: false,
  });

  const verificationQuery = useQuery({
    ...assistantsDomainsVerificationStatusRetrieveOptions({
      path: { assistant_id: assistantId ?? "", id: domain?.id ?? "" },
    }),
    enabled: !!assistantId && !!domain?.id && mode === "managed" && platformGate === "full",
    refetchInterval: (query) => {
      const st = query.state.data?.status;
      if (st === "verified" || st === "failed") return false;
      return 10_000;
    },
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (searchParams.get("release") !== "1" || !domain || address) return;
    setReleaseConfirmOpen(true);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("release");
      return next;
    }, { replace: true });
  }, [address, domain, searchParams, setSearchParams]);

  // -- Mutations -------------------------------------------------------------
  const registerDomain = useMutation(assistantsDomainsCreateMutation());
  const deleteDomain = useMutation(assistantsDomainsDestroyMutation());
  const registerAddress = useMutation(assistantsEmailAddressesCreateMutation());
  const deleteAddress = useMutation(assistantsEmailAddressesDestroyMutation());

  const invalidateEmailQueries = useCallback(() => {
    if (!assistantId) return;
    const path = { assistant_id: assistantId };
    void queryClient.invalidateQueries({
      queryKey: assistantsDomainsListQueryKey({ path }),
    });
    void queryClient.invalidateQueries({
      queryKey: assistantsEmailAddressesListQueryKey({ path }),
    });
    if (address?.id) {
      void queryClient.invalidateQueries({
        queryKey: assistantsEmailAddressesStatusRetrieveQueryKey({
          path: { ...path, id: address.id },
        }),
      });
    }
    // Domain registration can change the assistant's handle; invalidate the
    // assistant list so the cached handle stays fresh.
    void queryClient.invalidateQueries({
      queryKey: assistantsListQueryKey(),
    });
  }, [address?.id, assistantId, queryClient]);

  // -- Handlers --------------------------------------------------------------
  const handleRegisterDomain = useCallback(async () => {
    if (!assistantId) return;
    const trimmed = subdomainDraft.trim().toLowerCase();
    if (!trimmed) {
      setSubdomainError("Enter a subdomain.");
      return;
    }
    setRegisterConfirmOpen(false);
    try {
      await registerDomain.mutateAsync({
        path: { assistant_id: assistantId },
        body: { subdomain: trimmed },
      });
      setSubdomainDraft("");
      setSubdomainError(null);
      invalidateEmailQueries();
      toast.success(`Domain ${trimmed}.${emailRootDomain} registered.`);
    } catch (err) {
      setSubdomainError(
        extractErrorMessage(err, undefined, "Failed to register domain."),
      );
    }
  }, [
    assistantId,
    emailRootDomain,
    invalidateEmailQueries,
    registerDomain,
    subdomainDraft,
  ]);

  const handleRegisterAddress = useCallback(async () => {
    if (!assistantId) return;
    const trimmed = usernameDraft.trim().toLowerCase();
    if (!trimmed) {
      setUsernameError("Enter an email username.");
      return;
    }
    try {
      await registerAddress.mutateAsync({
        path: { assistant_id: assistantId },
        body: { username: trimmed },
      });
      setUsernameDraft("");
      setUsernameError(null);
      invalidateEmailQueries();
      toast.success("Email address created.");
    } catch (err) {
      setUsernameError(
        extractErrorMessage(err, undefined, "Failed to create email address."),
      );
    }
  }, [assistantId, invalidateEmailQueries, registerAddress, usernameDraft]);

  const handleDeleteAddress = useCallback(async () => {
    if (!assistantId || !address?.id) return;
    setRemoveAddressConfirmOpen(false);
    try {
      await deleteAddress.mutateAsync({
        path: { assistant_id: assistantId, id: address.id },
      });
      invalidateEmailQueries();
      toast.success("Email address removed.");
    } catch (err) {
      captureError(err, { context: "email_address_delete" });
      toast.error("Failed to remove email address.");
    }
  }, [address?.id, assistantId, deleteAddress, invalidateEmailQueries]);

  const handleDeleteDomain = useCallback(async () => {
    if (!assistantId || !domain?.id) return;
    if (address) {
      toast.error("Remove the email address first.");
      return;
    }
    setReleaseConfirmOpen(false);
    const releasedSubdomain = domain.subdomain;
    try {
      await deleteDomain.mutateAsync({
        path: { assistant_id: assistantId, id: domain.id },
      });
      setSubdomainDraft(releasedSubdomain);
      invalidateEmailQueries();
      toast.success("Domain released.");
    } catch (err) {
      captureError(err, { context: "email_domain_release" });
      toast.error("Failed to release domain.");
    }
  }, [
    address,
    assistantId,
    deleteDomain,
    domain?.id,
    domain?.subdomain,
    invalidateEmailQueries,
  ]);

  const handleModeChange = useCallback((next: ServiceMode) => {
    setMode(next);
    setLocalSetting(LS_EMAIL_MODE, next);
  }, []);

  const handleSaveMode = useCallback(async () => {
    setSavingMode(true);
    try {
      if (mode === "your-own") {
        setLocalSetting(LS_EMAIL_BYO_PROVIDER, byoProviderId);
      }
      toast.success("Email settings saved.");
    } finally {
      setSavingMode(false);
    }
  }, [byoProviderId, mode]);

  // -- Render ---------------------------------------------------------------
  const selectedByoProvider = useMemo(
    () =>
      EMAIL_BYO_PROVIDERS.find((p) => p.id === byoProviderId) ??
      EMAIL_BYO_PROVIDERS[0]!,
    [byoProviderId],
  );

  const byoSetupInstructions = (
    <div className="flex items-start gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3 text-body-small-default text-[var(--content-tertiary)]">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--system-positive-strong)]" />
      <div className="flex flex-col gap-1">
        <span>
          Configure {selectedByoProvider.displayName} via the assistant
          CLI: ask the assistant to run the{" "}
          <code className="rounded bg-[var(--surface-active)] px-1 py-0.5 text-[12px]">
            {selectedByoProvider.setupSkill}
          </code>{" "}
          skill. It walks you through storing the API key, detecting the
          domain, and (optionally) wiring up an inbound webhook.
        </span>
        <a
          href={selectedByoProvider.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[var(--system-positive-strong)] underline hover:opacity-80"
        >
          Open {selectedByoProvider.displayName}
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );

  const yourOwnContent = (
    <div className="space-y-4">
      <div className="space-y-1">
        <label className="block text-body-small-default text-[var(--content-tertiary)]">
          Provider
        </label>
        <Dropdown
          value={byoProviderId}
          onChange={(val) =>
            setByoProviderId(val as EmailByoProvider["id"])
          }
          options={EMAIL_BYO_PROVIDERS.map((p) => ({
            value: p.id,
            label: p.displayName,
          }))}
        />
      </div>

      {byoConfigured ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg border border-[var(--system-positive-subtle)] bg-[var(--surface-sunken)] p-3 text-body-small-default text-[var(--content-default)]">
            <CircleCheck className="h-4 w-4 shrink-0 text-[var(--system-positive-strong)]" />
            <span>
              {selectedByoProvider.displayName} API key configured.
              To reconfigure, run the{" "}
              <code className="rounded bg-[var(--surface-active)] px-1 py-0.5 text-[12px]">
                {selectedByoProvider.setupSkill}
              </code>{" "}
              skill.
            </span>
          </div>
          <a
            href={selectedByoProvider.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-body-small-default text-[var(--system-positive-strong)] underline hover:opacity-80"
          >
            Open {selectedByoProvider.displayName}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      ) : byoSetupInstructions}

      <div className="flex items-center gap-2">
        <SaveButton onClick={handleSaveMode} disabled={savingMode} />
        {savingMode && (
          <Loader2 className="h-4 w-4 animate-spin text-[var(--content-disabled)]" />
        )}
      </div>
    </div>
  );

  if (platformGate === "gated") {
    return (
      <DetailCard
        id="email"
        title="Email"
        subtitle="Configure how your assistant sends and receives email"
      >
        <div className="h-px bg-[var(--surface-active)]" />
        <div className="mt-4">{yourOwnContent}</div>
      </DetailCard>
    );
  }

  return (
    <ServiceCard
      id="email"
      title="Email"
      subtitle="Configure how your assistant sends and receives email"
      mode={mode}
      onModeChange={handleModeChange}
    >
      {mode === "managed" ? (
        <div className="space-y-4">
          {platformGate === "disabled" ? (
            <Notice tone="info">
              Log in to the Vellum platform to manage email settings.
            </Notice>
          ) : (
          <>
          {subscriptionUnknown && (
            <Notice
              tone="warning"
              title="Couldn't verify subscription status"
              actions={
                <Button
                  size="compact"
                  variant="outlined"
                  onClick={() => subscriptionQuery.refetch()}
                >
                  Retry
                </Button>
              }
            >
              We couldn&apos;t reach the billing service. The form below
              assumes managed email is enabled for your org — if it isn&apos;t,
              registering a domain will fail.
            </Notice>
          )}
          {subscriptionQuery.isLoading ? (
            <div className="flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking subscription…
            </div>
          ) : isExplicitlyNotEntitled ? (
            <Notice
              tone="info"
              icon={<Crown className="h-4 w-4" aria-hidden />}
              title="Get a dedicated email address for your assistant"
              actions={
                <Button
                  size="compact"
                  onClick={() => navigate(`${routes.settings.billing}?adjust_plan`)}
                >
                  Upgrade to Pro
                </Button>
              }
            >
              Pro plans include a managed{" "}
              {`<your-subdomain>.${emailRootDomain}`} inbox — no provider
              setup required. Or switch to <strong>Your Own</strong> to bring
              an existing provider.
            </Notice>
          ) : !assistantId ? (
            <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
              No assistant found yet.
            </p>
          ) : !domain ? (
            <div className="space-y-3">
              <label className="block text-body-small-default text-[var(--content-quiet)]">
                Subdomain
              </label>
              <DomainField
                subdomain={subdomainDraft}
                onSubdomainChange={(v) => {
                  setSubdomainDraft(v);
                  if (subdomainError) setSubdomainError(null);
                }}
                domainSuffix={emailRootDomain}
                subdomainPlaceholder="my-assistant"
                error={subdomainError}
              />
              <p className="text-body-small-default text-[var(--content-tertiary)]">
                Each assistant gets its own subdomain. Lowercase letters,
                numbers, and hyphens only.
              </p>
              <Button
                onClick={() => setRegisterConfirmOpen(true)}
                disabled={registerDomain.isPending || !subdomainDraft.trim()}
              >
                {registerDomain.isPending ? "Registering…" : "Register"}
              </Button>
              <ConfirmDialog
                open={registerConfirmOpen}
                title="Set Subdomain"
                message={<><code className="rounded bg-[var(--surface-active)] px-1 py-0.5 font-mono text-[0.9em]">{subdomainDraft.trim().toLowerCase() || "subdomain"}</code> will also become your assistant's public handle. You won't be able to change it once set.</>}
                confirmLabel="Confirm"
                onConfirm={handleRegisterDomain}
                onCancel={() => setRegisterConfirmOpen(false)}
              />
            </div>
          ) : !address ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-body-small-default text-[var(--content-quiet)]">
                  Domain
                </label>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-body-small-default text-[var(--content-default)]">
                    {domain.subdomain}.{emailRootDomain}
                  </span>
                  <DomainVerificationChip
                    status={verificationQuery.data?.status}
                    message={verificationQuery.data?.message}
                    isLoading={verificationQuery.isLoading}
                  />
                  <Button
                    variant="dangerGhost"
                    size="compact"
                    iconOnly={<Trash2 />}
                    onClick={() => setReleaseConfirmOpen(true)}
                    disabled={deleteDomain.isPending}
                    aria-label="Release domain"
                  />
                </div>
                <ConfirmDialog
                  open={releaseConfirmOpen}
                  title="Release Domain"
                  message={<>Are you sure you want to release <code className="rounded bg-[var(--surface-active)] px-1 py-0.5 font-mono text-[0.9em]">{domain.subdomain}.{emailRootDomain}</code>? The subdomain will become available for others to claim.</>}
                  confirmLabel="Release"
                  destructive
                  onConfirm={handleDeleteDomain}
                  onCancel={() => setReleaseConfirmOpen(false)}
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-body-small-default text-[var(--content-quiet)]">
                  Email address
                </label>
                <div className="flex items-center gap-2">
                  <div className={`flex h-9 min-w-0 flex-1 items-center rounded-md border bg-[var(--field-bg)] text-body-medium-lighter transition-[border-color] duration-150 ${usernameError ? "border-[var(--system-negative-strong)]" : "border-[var(--field-border)] focus-within:border-[var(--border-active)]"}`}>
                    <input
                      value={usernameDraft}
                      onChange={(e) => {
                        setUsernameDraft(e.target.value.toLowerCase());
                        if (usernameError) setUsernameError(null);
                      }}
                      placeholder="hi"
                      aria-label="Email username"
                      aria-invalid={!!usernameError}
                      className="h-full min-w-0 flex-1 bg-transparent pl-3 pr-1 text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none"
                    />
                    <span className="shrink-0 pr-3 font-mono text-[var(--content-secondary)]">
                      @{fullDomain}
                    </span>
                  </div>
                  <Button
                    onClick={handleRegisterAddress}
                    disabled={
                      registerAddress.isPending || !usernameDraft.trim()
                    }
                  >
                    {registerAddress.isPending ? "Creating…" : "Create"}
                  </Button>
                </div>
                {usernameError && (
                  <p className="text-body-small-default text-[var(--system-negative-strong)]">
                    {usernameError}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-body-small-default text-[var(--content-quiet)]">
                  Address
                </label>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-body-small-default text-[var(--content-default)]">
                    {address.address}
                  </span>
                  <DomainVerificationChip
                    status={verificationQuery.data?.status}
                    message={verificationQuery.data?.message}
                    isLoading={verificationQuery.isLoading}
                  />
                  <Button
                    variant="dangerGhost"
                    size="compact"
                    iconOnly={<Trash2 />}
                    onClick={() => setRemoveAddressConfirmOpen(true)}
                    disabled={deleteAddress.isPending}
                    aria-label="Remove email address"
                  />
                </div>
                <ConfirmDialog
                  open={removeAddressConfirmOpen}
                  title="Remove Email Address"
                  message={<>Are you sure you want to remove <code className="rounded bg-[var(--surface-active)] px-1 py-0.5 font-mono text-[0.9em]">{address.address}</code>? Your assistant will no longer be able to send or receive email at this address.</>}
                  confirmLabel="Remove"
                  destructive
                  onConfirm={handleDeleteAddress}
                  onCancel={() => setRemoveAddressConfirmOpen(false)}
                />
              </div>

              {statusQuery.data?.usage && (
                <p className="text-body-small-default text-[var(--content-tertiary)]">
                  {statusQuery.data.usage.sent_today} /{" "}
                  {statusQuery.data.usage.daily_limit} sent today ·{" "}
                  {statusQuery.data.usage.received_today} received
                </p>
              )}
            </div>
          )}
          </>
          )}
        </div>
      ) : yourOwnContent}
    </ServiceCard>
  );
}
