import { useEffect, useRef } from "react";

import type { MutationStatus } from "@/components/channel-setup-wizard";

/**
 * Empty submitted credential fields once their save succeeds.
 *
 * Neither setup surface unmounts a wizard on success, and the Channels page
 * keeps it mounted while readiness catches up, so without this a submitted
 * token stays in a live field, recoverable from a mounted component long
 * after it was handed over.
 *
 * The setters are held in a ref because a rest parameter builds a fresh array
 * every render, which as a dependency would re-run the clear continuously.
 * The ref is refreshed in its own effect, which runs before the clear below.
 */
export function useClearOnSaveSuccess(
  saveStatus: MutationStatus,
  ...setters: Array<(value: string) => void>
): void {
  const settersRef = useRef(setters);

  useEffect(() => {
    settersRef.current = setters;
  });

  useEffect(() => {
    if (saveStatus !== "success") {
      return;
    }
    for (const setValue of settersRef.current) {
      setValue("");
    }
  }, [saveStatus]);
}
