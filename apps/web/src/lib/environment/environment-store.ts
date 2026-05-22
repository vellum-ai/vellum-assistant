import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";

export interface EnvironmentConfig {
  emailRootDomain: string;
  isNonProduction: boolean;
}

interface EnvironmentActions {
  setEnvironment: (config: Partial<EnvironmentConfig>) => void;
}

type EnvironmentStore = EnvironmentConfig & EnvironmentActions;

const DEFAULT_ENVIRONMENT: EnvironmentConfig = {
  emailRootDomain: "vellum.me",
  isNonProduction: false,
};

const useEnvironmentStoreBase = create<EnvironmentStore>()((set) => ({
  ...DEFAULT_ENVIRONMENT,
  setEnvironment: (config) => set(config),
}));

export const useEnvironmentStore = createSelectors(useEnvironmentStoreBase);
