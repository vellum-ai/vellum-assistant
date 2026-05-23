import {
  ChartColumn,
  ChevronDown,
  ChevronUp,
  LogOut,
  MessageSquareText,
  Settings as SettingsIcon,
  Shield,
  SlidersHorizontal,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import {
  BottomSheet,
  PanelItem,
  Popover,
  SideMenu,
} from "@vellum/design-library";

import { useIsMobile } from "@/hooks/use-is-mobile.js";
import { useAuthStore } from "@/stores/auth-store.js";
import { adminUrl, routes } from "@/utils/routes.js";
import { ShareFeedbackModal } from "@/components/share-feedback-modal.js";
import { ThemeToggle } from "@/components/theme-toggle.js";

export interface PreferencesMenuProps {
  assistantId?: string | null;
  assistantVersion?: string | null;
  activeConversationId?: string | null;
}

export function PreferencesMenu({
  assistantId,
  assistantVersion,
  activeConversationId,
}: PreferencesMenuProps) {
  const isLoggedIn = useAuthStore.use.isLoggedIn();
  const isMobile = useIsMobile();
  const [isOpen, setIsOpen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);

  if (!isLoggedIn) {
    return null;
  }

  const closeMenu = () => setIsOpen(false);

  const trigger = (
    <SideMenu.Item
      icon={SlidersHorizontal}
      label="Preferences"
      trailingIcon={isOpen ? ChevronDown : ChevronUp}
      active={isOpen}
    />
  );

  const content = (
    <PreferencesMenuContent
      onClose={closeMenu}
      onShareFeedback={() => setIsFeedbackOpen(true)}
    />
  );

  return (
    <>
      {isMobile ? (
        <BottomSheet.Root open={isOpen} onOpenChange={setIsOpen}>
          <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
          <BottomSheet.Content>
            <BottomSheet.Header className="sr-only">
              <BottomSheet.Title>Preferences</BottomSheet.Title>
            </BottomSheet.Header>
            <BottomSheet.Body className="pt-0">{content}</BottomSheet.Body>
          </BottomSheet.Content>
        </BottomSheet.Root>
      ) : (
        <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
          <Popover.Trigger asChild>{trigger}</Popover.Trigger>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={8}
            className="w-64 rounded-lg p-4"
          >
            {content}
          </Popover.Content>
        </Popover.Root>
      )}

      <ShareFeedbackModal
        open={isFeedbackOpen}
        onClose={() => setIsFeedbackOpen(false)}
        assistantId={assistantId}
        assistantVersion={assistantVersion}
        activeConversationId={activeConversationId}
      />
    </>
  );
}

interface PreferencesMenuContentProps {
  onClose: () => void;
  onShareFeedback: () => void;
}

function PreferencesMenuContent({
  onClose,
  onShareFeedback,
}: PreferencesMenuContentProps) {
  const navigate = useNavigate();
  const logout = useAuthStore.use.logout();
  const user = useAuthStore.use.user();

  return (
    <>
      <ThemeToggle className="px-2 pt-0" />

      <MenuDivider />

      <PanelItem
        icon={SettingsIcon}
        label="Settings"
        onSelect={() => {
          onClose();
          navigate(routes.settings.root);
        }}
      />

      <PanelItem
        icon={ChartColumn}
        label="Usage"
        onSelect={() => {
          onClose();
          navigate(routes.logs.usage);
        }}
      />

      <PanelItem
        icon={MessageSquareText}
        label="Share Feedback"
        onSelect={() => {
          onClose();
          onShareFeedback();
        }}
      />

      {user?.isStaff ? (
        <PanelItem
          icon={Shield}
          label="Admin"
          onSelect={() => {
            onClose();
            window.location.href = adminUrl();
          }}
        />
      ) : null}

      <PanelItem
        icon={LogOut}
        label="Log Out"
        onSelect={async () => {
          await logout();
          onClose();
          navigate(routes.account.login);
        }}
      />
    </>
  );
}

function MenuDivider() {
  return (
    <div
      aria-hidden="true"
      className="my-1 h-px"
      style={{ background: "var(--border-overlay)" }}
    />
  );
}
