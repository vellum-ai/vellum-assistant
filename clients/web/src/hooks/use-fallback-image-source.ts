import { useState } from "react";

interface FailedImageSources {
  candidateKey: string;
  sources: readonly string[];
}

export function useFallbackImageSource(
  candidates: readonly (string | null | undefined)[],
) {
  const sources = candidates.filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  const candidateKey = sources.join("\0");
  const [failed, setFailed] = useState<FailedImageSources>({
    candidateKey,
    sources: [],
  });
  const failedSources =
    failed.candidateKey === candidateKey ? failed.sources : [];
  const source = sources.find((candidate) => !failedSources.includes(candidate));

  const handleError = () => {
    if (!source) {
      return;
    }
    setFailed((previous) => {
      const previousSources =
        previous.candidateKey === candidateKey ? previous.sources : [];
      return {
        candidateKey,
        sources: previousSources.includes(source)
          ? previousSources
          : [...previousSources, source],
      };
    });
  };

  return { handleError, source };
}
