import { useEffect } from "react";
import { createRoot } from "react-dom/client";

import { useEdgeSwipe } from "../../src/hooks/use-edge-swipe";

declare global {
  interface Window {
    edgeSwipeTest: {
      ready: boolean;
      confirms: number;
      moves: number;
      commits: number;
    };
  }
}

window.edgeSwipeTest = { ready: false, confirms: 0, moves: 0, commits: 0 };

function GestureHarness() {
  useEdgeSwipe({
    enabled: true,
    onConfirm: () => {
      window.edgeSwipeTest.confirms++;
    },
    onMove: () => {
      window.edgeSwipeTest.moves++;
    },
    onCommit: () => {
      window.edgeSwipeTest.commits++;
    },
    onCancel: () => {},
  });
  useEffect(() => {
    window.edgeSwipeTest.ready = true;
  }, []);
  return null;
}

createRoot(document.getElementById("root")!).render(<GestureHarness />);
