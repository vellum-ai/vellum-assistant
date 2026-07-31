import { useEffect, useState } from "react";

/** Any parsed OOXML payload that carries embedded media alongside its content. */
interface OoxmlContent {
  media: Map<string, Blob>;
}

export type OoxmlParseState<T> =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      content: T;
      /** Media path to an object URL that lives as long as this state does. */
      mediaUrls: Map<string, string>;
    };

/**
 * Parse an OOXML blob and expose its embedded media as object URLs.
 *
 * The URLs are created once the parse resolves and revoked when the blob
 * changes or the component unmounts, including when the parse resolves after
 * the caller has already gone away.
 *
 * `parse` must be a stable reference (a module-level function); it is a
 * dependency of the parse effect.
 */
export function useOoxmlParse<T extends OoxmlContent>(
  blob: Blob,
  parse: (blob: Blob) => Promise<T>,
): OoxmlParseState<T> {
  const [state, setState] = useState<OoxmlParseState<T>>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    let created: string[] = [];
    const revokeAll = (): void => {
      for (const url of created) {
        URL.revokeObjectURL(url);
      }
      created = [];
    };

    setState({ status: "loading" });
    parse(blob)
      .then((content) => {
        const mediaUrls = new Map<string, string>();
        for (const [path, media] of content.media) {
          const url = URL.createObjectURL(media);
          created.push(url);
          mediaUrls.set(path, url);
        }
        if (cancelled) {
          revokeAll();
          return;
        }
        setState({ status: "ready", content, mediaUrls });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "error" });
        }
      });

    return () => {
      cancelled = true;
      revokeAll();
    };
  }, [blob, parse]);

  return state;
}
