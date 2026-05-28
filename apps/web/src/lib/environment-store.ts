import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

export interface EnvironmentConfig {
  emailRootDomain: string;
  isNonProduction: boolean;
}

interface EnvironmentActions {
  setEnvironment: (config: Partial<EnvironmentConfig>) => void;
}

type EnvironmentStore = EnvironmentConfig & EnvironmentActions;

function getDefaultEnvironment(): EnvironmentConfig {
  const env = import.meta.env.VITE_SENTRY_ENVIRONMENT;
  const isNonProduction = !env || env !== "production";

  let emailRootDomain: string;
  if (!env || env === "local") emailRootDomain = "local.vellum.me";
  else if (env === "dev") emailRootDomain = "dev.vellum.me";
  else if (env === "staging") emailRootDomain = "staging.vellum.me";
  else emailRootDomain = "vellum.me";

  return { emailRootDomain, isNonProduction };
}

const useEnvironmentStoreBase = create<EnvironmentStore>()((set) => ({
  ...getDefaultEnvironment(),
  setEnvironment: (config) => set(config),
}));

export const useEnvironmentStore = createSelectors(useEnvironmentStoreBase);
