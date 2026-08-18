import { Plus } from "lucide-react";
import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@vellumai/design-library/components/button";
import { Skeleton } from "@vellumai/design-library/components/skeleton";
import { Typography } from "@vellumai/design-library/components/typography";

import { LanguageModelSection } from "@/domains/settings/ai/language-model-section";
import { ProviderRow } from "@/domains/settings/ai/provider-row";
import { VELLUM_CONNECTION_PROVIDER } from "@/domains/settings/ai/constants";
import { useProviderActions } from "@/domains/settings/ai/use-provider-actions";
import {
  configLlmDefaultproviderGetOptions,
  inferenceProviderconnectionsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useSupportsDefaultProviderSettings } from "@/lib/backwards-compat/default-provider-settings";
import { useTranslation } from "@/i18n";

interface ProvidersSectionProps {
  assistantId: string;
  /** Name of the connection currently open in the sidepanel, if any. */
  selectedConnectionName: string | null;
  onOpenConnection: (name: string) => void;
  onAddProvider: () => void;
  /**
   * Deleting the connection that's open in the sidepanel must also close
   * the panel; the page passes the close-through here.
   */
  onConnectionDeleted: (name: string) => void;
}

/**
 * The inline Providers list of the Language Model card (Figma
 * 7412:133535): the managed Vellum row first, then BYOK/custom
 * connections. Rows open the sidepanel editor; the kebab carries Set as
 * default / Edit / Delete per row eligibility.
 */
export function ProvidersSection({
  assistantId,
  selectedConnectionName,
  onOpenConnection,
  onAddProvider,
  onConnectionDeleted,
}: ProvidersSectionProps) {
  const { t } = useTranslation("settings");
  const {
    data,
    isLoading,
    isError,
  } = useQuery(
    inferenceProviderconnectionsGetOptions({
      path: { assistant_id: assistantId },
    }),
  );

  // Older assistants 404 the default-provider routes; the gate keeps the
  // query dark and the Default chip + Set-as-default action hidden.
  const supportsDefaultProvider = useSupportsDefaultProviderSettings();
  const { data: defaultProviderStatus } = useQuery({
    ...configLlmDefaultproviderGetOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: supportsDefaultProvider,
  });
  const defaultConnectionName = supportsDefaultProvider
    ? (defaultProviderStatus?.resolvedConnectionName ?? null)
    : null;

  const actions = useProviderActions(assistantId, {
    onDeleted: onConnectionDeleted,
  });

  // Managed Vellum row pinned first, matching the Figma order.
  const connections = useMemo(() => {
    const fetched = data?.connections ?? [];
    return [
      ...fetched.filter((c) => c.provider === VELLUM_CONNECTION_PROVIDER),
      ...fetched.filter((c) => c.provider !== VELLUM_CONNECTION_PROVIDER),
    ];
  }, [data]);

  return (
    <LanguageModelSection
      title={t("providersSection.title")}
      action={
        <Button
          variant="outlined"
          onClick={onAddProvider}
          leftIcon={<Plus />}
        >
          {t("providersSection.addProvider")}
        </Button>
      }
    >
      {isLoading ? (
        <div className="space-y-2 py-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 rounded-lg" />
          ))}
        </div>
      ) : isError ? (
        <Typography
          variant="body-medium-default"
          as="p"
          className="py-4 text-center text-(--system-negative-strong)"
        >
          {t("providersSection.loadError")}
        </Typography>
      ) : connections.length === 0 ? (
        <Typography
          variant="body-medium-lighter"
          as="p"
          className="py-4 text-center text-(--content-tertiary)"
        >
          {t("providersSection.empty")}
        </Typography>
      ) : (
        connections.map((conn) => (
          <ProviderRow
            key={conn.name}
            connection={conn}
            isDefault={conn.name === defaultConnectionName}
            supportsDefaultProvider={supportsDefaultProvider}
            selected={conn.name === selectedConnectionName}
            isSettingDefault={actions.isSettingDefault(conn.name)}
            onOpen={
              (conn.isManaged ?? false)
                ? undefined
                : () => onOpenConnection(conn.name)
            }
            onSetDefault={() => actions.setDefault(conn)}
            onDelete={() => void actions.deleteConnection(conn.name)}
          />
        ))
      )}
    </LanguageModelSection>
  );
}
