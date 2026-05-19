import { Outlet, useLocation, useNavigate } from "react-router";
import { useCallback } from "react";
import { AssistantShell } from "./components/shell/assistant-shell.js";
import { SideMenu } from "./components/shell/side-menu.js";

export function App() {
  const navigate = useNavigate();
  const location = useLocation();

  const handleStartNewConversation = useCallback(() => {
    navigate("/");
  }, [navigate]);

  const handleOpenHome = useCallback(() => {
    navigate("/home");
  }, [navigate]);

  const isHomeActive = location.pathname === "/home";

  return (
    <AssistantShell
      sideMenu={(args) => <SideMenu {...args} />}
      onStartNewConversation={handleStartNewConversation}
      onOpenHome={handleOpenHome}
      isHomeActive={isHomeActive}
      canGoBack={window.history.length > 1}
      onGoBack={() => navigate(-1)}
      onGoForward={() => navigate(1)}
    >
      <Outlet />
    </AssistantShell>
  );
}
