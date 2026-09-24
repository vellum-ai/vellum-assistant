/**
 * Run one asynchronous read per source and drop a reply that lands after the
 * source changed or the component unmounted, which is the shape every reader
 * in the document drawer needs to turn a blob into something renderable. The
 * state handed back always belongs to the source the caller passed.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface AsyncRead<T> {
  /** What the read resolved to, or `null` while it is in flight. */
  value: T | null;
  /** Whether the read rejected, which the caller shows as a failure state. */
  failed: boolean;
}

/** A read tagged with the source it answers, which only the hook sees. */
interface Read<S, T> extends AsyncRead<T> {
  source: S;
}

/** Shared so a state belonging to another source reads as one object. */
const PENDING: AsyncRead<never> = { value: null, failed: false };

export function useAsyncRead<S, T>(
  source: S,
  read: (source: S) => Promise<T>,
): AsyncRead<T> {
  const [state, setState] = useState<Read<S, T>>({
    source,
    value: null,
    failed: false,
  });

  // Only `source` starts a read, so the caller may pass an inline closure
  // without every render restarting the one in flight.
  const latestRead = useRef(read);
  useLayoutEffect(() => {
    latestRead.current = read;
  });

  useEffect(() => {
    let cancelled = false;
    // Releases the previous source's value while the new read is in flight. A
    // state already pending for this source is kept, so a mount renders once
    // before its read resolves.
    setState((current) =>
      current.source === source && current.value === null && !current.failed
        ? current
        : { source, value: null, failed: false },
    );
    latestRead.current(source).then(
      (value) => {
        if (!cancelled) {
          setState({ source, value, failed: false });
        }
      },
      () => {
        if (!cancelled) {
          setState({ source, value: null, failed: true });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source]);

  // A state that belongs to a source other than the current one reads as
  // pending, so the render after a source change never shows the previous
  // source's value.
  return state.source === source ? state : PENDING;
}
