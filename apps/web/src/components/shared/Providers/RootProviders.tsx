
import { ReactNode } from "react";

import { AuthProvider } from "@/lib/auth.js";

import { SafeAreaBridge } from "@/components/shared/Providers/SafeAreaBridge.js";

interface RootProvidersProps {
  children: ReactNode;
}

export function RootProviders({ children }: RootProvidersProps) {
  return (
    <AuthProvider>
      <SafeAreaBridge />
      {children}
    </AuthProvider>
  );
}
