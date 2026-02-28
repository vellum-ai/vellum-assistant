/**
 * Minimal recording types used by the Twitter session module.
 * Inlined from assistant/src/tools/browser/network-recording-types.ts.
 */

export interface ExtractedCredential {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  expires?: number;
}

export interface SessionRecording {
  id: string;
  cookies?: ExtractedCredential[];
}
