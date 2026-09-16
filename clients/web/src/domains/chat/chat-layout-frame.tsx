import type { ReactNode } from "react";
import { Outlet } from "react-router";

import { useIsMobile } from "@/hooks/use-is-mobile";

interface ChatLayoutFrameProps {
  isPopout: boolean;
  mainRoomClass: string;
  routeContentInert: boolean;
  desktopNavigation: ReactNode;
  desktopPreview: ReactNode;
  sleepStage: ReactNode;
  popoutVoiceSession: ReactNode;
  desktopVoiceRoom: ReactNode;
  mobileDrawer: ReactNode;
}

/** Keeps the routed chat subtree under one wrapper and main at every width. */
export function ChatLayoutFrame({
  isPopout,
  mainRoomClass,
  routeContentInert,
  desktopNavigation,
  desktopPreview,
  sleepStage,
  popoutVoiceSession,
  desktopVoiceRoom,
  mobileDrawer,
}: ChatLayoutFrameProps) {
  const isMobile = useIsMobile();
  const frameClass = isMobile
    ? "flex-col"
    : isPopout
      ? "flex-col"
      : "flex-col gap-4 p-4 md:flex-row";
  const mainClass = !isMobile && isPopout ? "p-4" : "";

  return (
    <>
      <div
        className={`flex min-h-0 min-w-0 flex-1 overflow-hidden ${frameClass}`}
      >
        {!isMobile && !isPopout ? desktopNavigation : null}
        <main
          key="chat-main"
          className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${mainClass} ${mainRoomClass}`}
        >
          {/* The route remains mounted while the voice or sleep surface holds
              it inert, keeping the header and navigation reachable. */}
          <div
            className="relative flex min-h-0 min-w-0 flex-1 flex-col"
            inert={routeContentInert}
          >
            <Outlet />
            {desktopPreview}
          </div>
          {sleepStage}
          {isPopout ? popoutVoiceSession : null}
          {!isMobile && !isPopout ? desktopVoiceRoom : null}
        </main>
      </div>
      {/* The drawer stays outside the filtered main so its fixed positioning,
          opacity, and stacking order resolve against the viewport. */}
      {isMobile ? mobileDrawer : null}
    </>
  );
}
