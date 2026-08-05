import { type ReactNode } from "react";
import { Navigate } from "react-router";

import { ANDROID_BILLING_MESSAGE } from "@/lib/billing/android-consumption-only";
import { useIsNativeAndroid } from "@/runtime/platform-detection";
import { routes } from "@/utils/routes";
import { Notice } from "@vellumai/design-library/components/notice";

interface AndroidBillingGateProps {
  children: ReactNode;
  redirectToBilling?: boolean;
}

export function AndroidBillingGate({
  children,
  redirectToBilling = false,
}: AndroidBillingGateProps) {
  const isNativeAndroid = useIsNativeAndroid();

  if (!isNativeAndroid) {
    return children;
  }

  if (redirectToBilling) {
    return <Navigate replace to={routes.settings.usageBilling} />;
  }

  return <Notice tone="info">{ANDROID_BILLING_MESSAGE}</Notice>;
}
