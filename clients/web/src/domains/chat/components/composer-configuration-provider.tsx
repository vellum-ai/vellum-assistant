import { createContext, useContext, type ReactNode } from "react";
import {
  useComposerConfiguration,
  type ComposerConfiguration,
} from "@/domains/chat/hooks/use-composer-configuration";

const ConfigurationContext = createContext<ComposerConfiguration | null>(null);

function ConnectedComposerConfigurationProvider({
  assistantId,
  conversationId,
  children,
}: {
  assistantId: string;
  conversationId: string | undefined;
  children: ReactNode;
}) {
  const configuration = useComposerConfiguration(assistantId, conversationId);
  return (
    <ConfigurationContext.Provider value={configuration}>
      {children}
    </ConfigurationContext.Provider>
  );
}

export function useComposerConfigurationContext() {
  return useContext(ConfigurationContext);
}

export function ComposerConfigurationProvider({
  assistantId,
  conversationId,
  children,
}: {
  assistantId: string | null;
  conversationId: string | undefined;
  children: ReactNode;
}) {
  return assistantId ? (
    <ConnectedComposerConfigurationProvider
      assistantId={assistantId}
      conversationId={conversationId}
    >
      {children}
    </ConnectedComposerConfigurationProvider>
  ) : (
    children
  );
}
