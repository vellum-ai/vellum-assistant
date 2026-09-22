import { useState } from "react";
import { ArrowUpRight, Check, LockKeyhole, X } from "lucide-react";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Typography } from "@vellumai/design-library/components/typography";
import {
  isDraggablePermission,
  type SystemPermissionKind,
} from "@vellumai/ipc-contract";

import { useTranslation } from "@/i18n";
import { beginPermissionGuide } from "@/runtime/permission-setup";
import {
  openSystemPermissionSettings,
  requestSystemPermission,
  useSystemPermissionsState,
} from "@/runtime/system-permissions";
import { PERMISSION_ORDER, permissionSetupCopy } from "./permission-setup-copy";
import { usePermissionGuide } from "./use-permission-guide";
import "./permission-setup.css";

export function PermissionSetupPage() {
  const { t } = useTranslation();
  const { state, loading, error, refresh } = useSystemPermissionsState();
  const guide = usePermissionGuide();
  const [pending, setPending] = useState<SystemPermissionKind | null>(null);
  const [failed, setFailed] = useState(false);

  const allow = async (kind: SystemPermissionKind, row: HTMLElement) => {
    const item = state?.[kind];
    if (!item || pending) {
      return;
    }
    setPending(kind);
    setFailed(false);
    try {
      if (isDraggablePermission(kind)) {
        const { x, y, width, height } = row.getBoundingClientRect();
        await beginPermissionGuide(kind, { x, y, width, height });
      } else if (item.status === "denied" || !item.canRequest) {
        await openSystemPermissionSettings(kind);
      } else {
        await requestSystemPermission(kind);
      }
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setPending(null);
    }
  };

  return (
    <main className="permission-setup" data-theme="dark">
      <div className="permission-titlebar">
        <Button
          variant="ghost"
          size="compact"
          iconOnly={<X />}
          aria-label={t("permissionSetup.close")}
          onClick={() => window.close()}
        />
        <Typography variant="label-small-default">
          {t("permissionSetup.eyebrow")}
        </Typography>
      </div>
      <header className="permission-header">
        <img
          className="permission-brand"
          src={`${import.meta.env.BASE_URL}favicon.svg`}
          alt=""
        />
        <Typography as="h1" variant="title-large">
          {t("permissionSetup.title")}
        </Typography>
        <Typography as="p" variant="body-medium-lighter">
          {t("permissionSetup.description")}
        </Typography>
      </header>
      <div className="permission-rows" aria-busy={loading}>
        {!state && (
          <Typography as="p" variant="body-medium-lighter">
            {t("systemPermissionsCard.checking")}
          </Typography>
        )}
        {state &&
          PERMISSION_ORDER.map((kind) => {
            const item = state[kind];
            const {
              icon: Icon,
              label,
              description,
            } = permissionSetupCopy(kind, t);
            const granted = item.status === "granted";
            const lifted = guide?.kind === kind && !granted;
            return (
              <Card.Root
                key={kind}
                noPadding
                className="permission-row"
                data-granted={granted}
                data-lifted={lifted}
              >
                {lifted ? (
                  <div className="permission-placeholder" role="status">
                    <ArrowUpRight size={18} />
                    <Typography variant="label-small-default">
                      {t("permissionSetup.completeInSettings", {
                        permission: label,
                      })}
                    </Typography>
                  </div>
                ) : (
                  <>
                    <span className={`permission-icon permission-icon-${kind}`}>
                      <Icon size={27} strokeWidth={1.6} />
                    </span>
                    <div className="permission-copy">
                      <Typography as="h2" variant="body-large-default">
                        {label}
                      </Typography>
                      <Typography as="p" variant="body-small-lighter">
                        {description}
                      </Typography>
                    </div>
                    {granted ? (
                      <span className="permission-done" role="status">
                        <Check size={16} />
                        <Typography variant="label-small-default">
                          {t("permissionSetup.allowed")}
                        </Typography>
                      </span>
                    ) : item.status === "restricted" ? (
                      <Typography variant="label-small-default">
                        {t("permissionSetup.managed")}
                      </Typography>
                    ) : (
                      <Button
                        variant="outlined"
                        shape="pill"
                        size="regular"
                        loading={pending === kind}
                        disabled={pending !== null && pending !== kind}
                        aria-label={t("permissionSetup.allowPermission", {
                          permission: label,
                        })}
                        onClick={(event) => {
                          const row =
                            event.currentTarget.closest<HTMLElement>(
                              ".permission-row",
                            );
                          if (row) {
                            void allow(kind, row);
                          }
                        }}
                      >
                        {t("permissionSetup.allow")}
                      </Button>
                    )}
                  </>
                )}
              </Card.Root>
            );
          })}
        {(error || failed) && (
          <div role="alert" className="permission-error">
            <Typography variant="body-small-lighter">
              {t("permissionSetup.error")}
            </Typography>
            <Button
              variant="ghost"
              size="compact"
              onClick={() => {
                setFailed(false);
                void refresh().catch(() => setFailed(true));
              }}
            >
              {t("permissionSetup.retry")}
            </Button>
          </div>
        )}
      </div>
      <footer className="permission-footer">
        <LockKeyhole size={14} />
        <Typography as="p" variant="body-small-lighter">
          {t("permissionSetup.control")}
        </Typography>
        <Button
          variant="ghost"
          shape="pill"
          size="regular"
          onClick={() => window.close()}
        >
          {t("permissionSetup.done")}
        </Button>
      </footer>
    </main>
  );
}
