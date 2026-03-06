/** Types for CDP network recording. Inlined from assistant/src/tools/browser/network-recording-types.ts */

export interface NetworkRecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  postData?: string;
}

export interface NetworkRecordedResponse {
  status: number;
  headers: Record<string, string>;
  mimeType: string;
  body?: string;
}

export interface NetworkRecordedEntry {
  requestId: string;
  resourceType: string;
  timestamp: number;
  request: NetworkRecordedRequest;
  response?: NetworkRecordedResponse;
}

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
  startedAt: number;
  endedAt: number;
  targetDomain?: string;
  networkEntries: NetworkRecordedEntry[];
  cookies: ExtractedCredential[];
  observations: Array<{
    ocrText: string;
    appName?: string;
    windowTitle?: string;
    timestamp: number;
    captureIndex: number;
  }>;
}
