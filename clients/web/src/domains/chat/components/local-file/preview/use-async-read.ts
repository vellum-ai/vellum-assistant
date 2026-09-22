/**
 * Run one asynchronous read per source and drop a reply that lands after the
 * source changed or the component unmounted, which is the shape every reader
 * in the document drawer needs to turn a blob into something renderable.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface AsyncRead<T> {
  /** What the read resolved to, or `null` while it is in flight. */
  value: T | null;
  /** Whether the read rejected, which the caller shows as a failure state. */
  failed: boolean;
}

/** Shared so a second `setState` with nothing read yet bails out. */
const PENDING = { value: null, failed: false } as const;

export function useAsyncRead<S, T>(
  source: S,
  read: (source: S) => Promise<T>,
): AsyncRead<T> {
  const [state, setState] = useState<AsyncRead<T>>(PENDING);

  // Only `source` starts a read, so the caller may pass an inline closure
  // without every render restarting the one in flight.
  const latestRead = useRef(read);
  useLayoutEffect(() => {
    latestRead.current = read;
  });

  useEffect(() => {
    let cancelled = false;
    setState(PENDING);
    latestRead.current(source).then(
      (value) => {
        if (!cancelled) {
          setState({ value, failed: false });
        }
      },
      () => {
        if (!cancelled) {
          setState({ value: null, failed: true });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source]);

  return state;
}
