import { Loader2, Mail, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { DomainField } from "@/domains/channels/components/domain-field";
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
import { captureError } from "@/lib/sentry/capture-error";
import { extractErrorMessage } from "@/utils/api-errors";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";

import { Trans, useTranslation } from "@/i18n";

import { DomainVerificationChip } from "@/components/domain-verification-chip";

const CONFIRM_CODE_CLASS =
  "rounded bg-[var(--surface-active)] px-1 py-0.5 font-mono text-[0.9em]";

interface EmailManagedContentProps {
  assistantId: string;
  assistantHandle: string | undefined;
  emailRootDomain: string;
}

export function EmailManagedContent({
  assistantId,
  assistantHandle,
  emailRootDomain,
}: EmailManagedContentProps) {
  const { t } = useTranslation("channels");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [subdomainDraft, setSubdomainDraft] = useState("");
  const [subdomainPrefilled, setSubdomainPrefilled] = useState(false);
  const [subdomainError, setSubdomainError] = useState<string | null>(null);
  const [usernameDraft, setUsernameDraft] = useState("");
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [registerConfirmOpen, setRegisterConfirmOpen] = useState(false);
  const [releaseConfirmOpen, setReleaseConfirmOpen] = useState(false);
  const [removeAddressConfirmOpen, setRemoveAddressConfirmOpen] =
    useState(false);

  useEffect(() => {
    if (subdomainPrefilled || !assistantHandle || subdomainDraft) {
      return;
    }
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
    enabled: true,
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

  // -- Domain & address state ------------------------------------------------
  const domainsQuery = useQuery({
    ...assistantsDomainsListOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: !isExplicitlyNotEntitled,
  });
  const addressesQuery = useQuery({
    ...assistantsEmailAddressesListOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: !isExplicitlyNotEntitled,
  });

  const domain = domainsQuery.data?.results?.[0];
  const address = addressesQuery.data?.results?.[0];
  const fullDomain = domain ? `${domain.subdomain}.${emailRootDomain}` : null;

  const statusQuery = useQuery({
    ...assistantsEmailAddressesStatusRetrieveOptions({
      path: { assistant_id: assistantId, id: address?.id ?? "" },
    }),
    enabled: !!address?.id,
    refetchOnWindowFocus: false,
  });

  const verificationQuery = useQuery({
    ...assistantsDomainsVerificationStatusRetrieveOptions({
      path: { assistant_id: assistantId, id: domain?.id ?? "" },
    }),
    enabled: !!domain?.id,
    refetchInterval: (query) => {
      const st = query.state.data?.status;
      if (st === "verified" || st === "failed") {
        return false;
      }
      return 10_000;
    },
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (searchParams.get("release") !== "1" || !domain || address) {
      return;
    }
    setReleaseConfirmOpen(true);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("release");
        return next;
      },
      { replace: true },
    );
  }, [address, domain, searchParams, setSearchParams]);

  // -- Mutations -------------------------------------------------------------
  const registerDomain = useMutation(assistantsDomainsCreateMutation());
  const deleteDomain = useMutation(assistantsDomainsDestroyMutation());
  const registerAddress = useMutation(assistantsEmailAddressesCreateMutation());
  const deleteAddress = useMutation(assistantsEmailAddressesDestroyMutation());

  const invalidateEmailQueries = useCallback(() => {
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
    const trimmed = subdomainDraft.trim().toLowerCase();
    if (!trimmed) {
      setSubdomainError(t("emailManagedContent.enterSubdomainError"));
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
      toast.success(
        t("emailManagedContent.domainRegisteredToast", {
          domain: `${trimmed}.${emailRootDomain}`,
        }),
      );
    } catch (err) {
      setSubdomainError(
        extractErrorMessage(
          err,
          undefined,
          t("emailManagedContent.registerDomainFailedFallback"),
        ),
      );
    }
  }, [
    assistantId,
    emailRootDomain,
    invalidateEmailQueries,
    registerDomain,
    subdomainDraft,
    t,
  ]);

  const handleRegisterAddress = useCallback(async () => {
    const trimmed = usernameDraft.trim().toLowerCase();
    if (!trimmed) {
      setUsernameError(t("emailManagedContent.enterUsernameError"));
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
      toast.success(t("emailManagedContent.emailCreatedToast"));
    } catch (err) {
      setUsernameError(
        extractErrorMessage(
          err,
          undefined,
          t("emailManagedContent.createEmailFailedFallback"),
        ),
      );
    }
  }, [assistantId, invalidateEmailQueries, registerAddress, usernameDraft, t]);

  const handleDeleteAddress = useCallback(async () => {
    if (!address?.id) {
      return;
    }
    setRemoveAddressConfirmOpen(false);
    try {
      await deleteAddress.mutateAsync({
        path: { assistant_id: assistantId, id: address.id },
      });
      invalidateEmailQueries();
      toast.success(t("emailManagedContent.emailRemovedToast"));
    } catch (err) {
      captureError(err, { context: "email_address_delete" });
      toast.error(t("emailManagedContent.emailRemoveFailedToast"));
    }
  }, [address?.id, assistantId, deleteAddress, invalidateEmailQueries, t]);

  const handleDeleteDomain = useCallback(async () => {
    if (!domain?.id) {
      return;
    }
    if (address) {
      toast.error(t("emailManagedContent.removeAddressFirstToast"));
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
      toast.success(t("emailManagedContent.domainReleasedToast"));
    } catch (err) {
      captureError(err, { context: "email_domain_release" });
      toast.error(t("emailManagedContent.domainReleaseFailedToast"));
    }
  }, [
    address,
    assistantId,
    deleteDomain,
    domain?.id,
    domain?.subdomain,
    invalidateEmailQueries,
    t,
  ]);

  // -- Render ----------------------------------------------------------------
  if (subscriptionQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("emailManagedContent.checkingSubscription")}
      </div>
    );
  }

  if (isExplicitlyNotEntitled) {
    return (
      <Notice
        tone="info"
        icon={<Mail className="h-4 w-4" aria-hidden />}
        title={t("emailManagedContent.upgradeNoticeTitle")}
        actions={
          <Button size="compact" onClick={() => navigate(routes.plans)}>
            {t("emailManagedContent.upgradeButton")}
          </Button>
        }
      >
        {t("emailManagedContent.upgradeNoticeBody")}
      </Notice>
    );
  }

  // subscriptionUnknown: billing service unreachable. Render warning above
  // the form but still show the form (fail-open). The backend
  // `assert_entitlement` remains the source of truth — if the user isn't
  // entitled, domain registration will 403.
  const subscriptionWarning = subscriptionUnknown ? (
    <Notice
      tone="warning"
      title={t("emailManagedContent.subscriptionWarningTitle")}
      actions={
        <Button
          size="compact"
          variant="outlined"
          onClick={() => subscriptionQuery.refetch()}
        >
          {t("emailManagedContent.retry")}
        </Button>
      }
    >
      {t("emailManagedContent.subscriptionWarningBody")}
    </Notice>
  ) : null;

  if (!domain) {
    return (
      <div className="space-y-3">
        {subscriptionWarning}
        <label className="block text-body-small-default text-[var(--content-tertiary)]">
          {t("emailManagedContent.subdomainLabel")}
        </label>
        <DomainField
          subdomain={subdomainDraft}
          onSubdomainChange={(v) => {
            setSubdomainDraft(v);
            if (subdomainError) {
              setSubdomainError(null);
            }
          }}
          domainSuffix={emailRootDomain}
          subdomainPlaceholder={t(
            "emailManagedContent.subdomainExamplePlaceholder",
          )}
          error={subdomainError}
        />
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          {t("emailManagedContent.subdomainHint")}
        </p>
        <Button
          onClick={() => setRegisterConfirmOpen(true)}
          disabled={registerDomain.isPending || !subdomainDraft.trim()}
        >
          {registerDomain.isPending
            ? t("emailManagedContent.registering")
            : t("emailManagedContent.register")}
        </Button>
        <ConfirmDialog
          open={registerConfirmOpen}
          title={t("emailManagedContent.setSubdomainTitle")}
          message={
            <Trans
              i18nKey="emailManagedContent.setSubdomainConfirmMessage"
              ns="channels"
              values={{
                subdomain:
                  subdomainDraft.trim().toLowerCase() ||
                  t("emailManagedContent.subdomainFallback"),
              }}
              components={{
                code: <code className={CONFIRM_CODE_CLASS} />,
              }}
            />
          }
          confirmLabel={t("emailManagedContent.confirm")}
          onConfirm={handleRegisterDomain}
          onCancel={() => setRegisterConfirmOpen(false)}
        />
      </div>
    );
  }

  if (!address) {
    return (
      <div className="space-y-4">
        {subscriptionWarning}
        <div className="space-y-1.5">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            {t("emailManagedContent.domainLabel")}
          </label>
          <div className="flex items-center gap-2">
            <span className="font-mono text-body-small-default text-[var(--content-default)]">
              {domain.subdomain}.{emailRootDomain}
            </span>
            <DomainVerificationChip
              status={verificationQuery.data?.status}
              isLoading={verificationQuery.isLoading}
            />
            <Button
              variant="dangerGhost"
              size="compact"
              iconOnly={<Trash2 />}
              onClick={() => setReleaseConfirmOpen(true)}
              disabled={deleteDomain.isPending}
              aria-label={t("emailManagedContent.releaseDomainAriaLabel")}
            />
          </div>
          <ConfirmDialog
            open={releaseConfirmOpen}
            title={t("emailManagedContent.releaseDomainTitle")}
            message={
              <Trans
                i18nKey="emailManagedContent.releaseDomainConfirmMessage"
                ns="channels"
                values={{
                  domain: `${domain.subdomain}.${emailRootDomain}`,
                }}
                components={{
                  code: <code className={CONFIRM_CODE_CLASS} />,
                }}
              />
            }
            confirmLabel={t("emailManagedContent.releaseConfirm")}
            destructive
            onConfirm={handleDeleteDomain}
            onCancel={() => setReleaseConfirmOpen(false)}
          />
        </div>

        <div className="space-y-1.5">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            {t("emailManagedContent.emailAddressLabel")}
          </label>
          <div className="flex items-center gap-2">
            <div
              className={`flex h-9 min-w-0 flex-1 items-center rounded-md border bg-[var(--field-bg)] text-body-medium-lighter transition-[border-color] duration-150 ${usernameError ? "border-[var(--system-negative-strong)]" : "border-[var(--field-border)] focus-within:border-[var(--border-active)]"}`}
            >
              <input
                value={usernameDraft}
                onChange={(e) => {
                  setUsernameDraft(e.target.value.toLowerCase());
                  if (usernameError) {
                    setUsernameError(null);
                  }
                }}
                placeholder={t("emailManagedContent.emailUsernamePlaceholder")}
                aria-label={t("emailManagedContent.emailUsernameAriaLabel")}
                aria-invalid={!!usernameError}
                className="h-full min-w-0 flex-1 bg-transparent pl-3 pr-1 text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none"
              />
              <span className="shrink-0 pr-3 font-mono text-[var(--content-secondary)]">
                @{fullDomain}
              </span>
            </div>
            <Button
              onClick={handleRegisterAddress}
              disabled={registerAddress.isPending || !usernameDraft.trim()}
            >
              {registerAddress.isPending
                ? t("emailManagedContent.creating")
                : t("emailManagedContent.create")}
            </Button>
          </div>
          {usernameError && (
            <p className="text-body-small-default text-[var(--system-negative-strong)]">
              {usernameError}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {subscriptionWarning}
      <div className="space-y-1.5">
        <label className="block text-body-small-default text-[var(--content-tertiary)]">
          {t("emailManagedContent.addressLabel")}
        </label>
        <div className="flex items-center gap-2">
          <span className="font-mono text-body-small-default text-[var(--content-default)]">
            {address.address}
          </span>
          <DomainVerificationChip
            status={verificationQuery.data?.status}
            isLoading={verificationQuery.isLoading}
          />
          <Button
            variant="dangerGhost"
            size="compact"
            iconOnly={<Trash2 />}
            onClick={() => setRemoveAddressConfirmOpen(true)}
            disabled={deleteAddress.isPending}
            aria-label={t("emailManagedContent.removeEmailAriaLabel")}
          />
        </div>
        <ConfirmDialog
          open={removeAddressConfirmOpen}
          title={t("emailManagedContent.removeEmailTitle")}
          message={
            <Trans
              i18nKey="emailManagedContent.removeEmailConfirmMessage"
              ns="channels"
              values={{ address: address.address }}
              components={{
                code: <code className={CONFIRM_CODE_CLASS} />,
              }}
            />
          }
          confirmLabel={t("emailManagedContent.removeConfirm")}
          destructive
          onConfirm={handleDeleteAddress}
          onCancel={() => setRemoveAddressConfirmOpen(false)}
        />
      </div>

      {statusQuery.data?.usage && (
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          {t("emailManagedContent.usageSummary", {
            sent: statusQuery.data.usage.sent_today,
            limit: statusQuery.data.usage.daily_limit,
            received: statusQuery.data.usage.received_today,
          })}
        </p>
      )}
    </div>
  );
}
