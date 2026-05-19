import { useCallback, useRef } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";

import { AssistantShell } from "@/components/shell/assistant-shell.js";
import { SideMenu } from "@/components/shell/side-menu.js";

export function App() {
  const navigate = useNavigate();
  const location = useLocation();

  const historyIndexRef = useRef(0);
  const maxHistoryIndexRef = useRef(0);

  const prevLocationRef = useRef(location);
  if (prevLocationRef.current !== location) {
    historyIndexRef.current = window.history.state?.idx ?? 0;
    maxHistoryIndexRef.current = Math.max(
      maxHistoryIndexRef.current,
      historyIndexRef.current,
    );
    prevLocationRef.current = location;
  }

  const canGoBack = historyIndexRef.current > 0;
  const canGoForward = historyIndexRef.current < maxHistoryIndexRef.current;

  const handleStartNewConversation = useCallback(() => {
    navigate("/");
  }, [navigate]);

  const handleOpenHome = useCallback(() => {
    navigate("/home");
  }, [navigate]);

  const handleGoBack = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  const handleGoForward = useCallback(() => {
    navigate(1);
  }, [navigate]);

  const isHomeActive = location.pathname === "/home";

  return (
    <AssistantShell
      sideMenu={(args) => <SideMenu {...args} />}
      onStartNewConversation={handleStartNewConversation}
      onOpenHome={handleOpenHome}
      isHomeActive={isHomeActive}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      onGoBack={handleGoBack}
      onGoForward={handleGoForward}
    >
      <Outlet />
    </AssistantShell>
  );
}
