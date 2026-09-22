import { useEffect, useState } from "react";
import type { PermissionGuideState } from "@vellumai/ipc-contract";

import {
  getPermissionGuide,
  subscribePermissionGuide,
} from "@/runtime/permission-setup";

/** Mirror the native guide, including changes made by another permission window. */
export function usePermissionGuide() {
  const [guide, setGuide] = useState<PermissionGuideState | null>(null);
  useEffect(() => {
    let active = true;
    let received = false;
    const unsubscribe = subscribePermissionGuide((next) => {
      received = true;
      setGuide(next);
    });
    void getPermissionGuide()
      .then((next) => {
        if (active && !received) {
          setGuide(next);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return guide;
}
