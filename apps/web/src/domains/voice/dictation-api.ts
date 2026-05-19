// TODO: port from platform
export interface DictationContext {
  cursorInTextField?: boolean;
  [key: string]: unknown;
}

export interface DictationResult {
  mode: "transcription" | "command" | "dictation";
  text: string;
}

export async function postDictation(
  _transcription: string,
  _assistantId: string,
  _context?: DictationContext,
): Promise<DictationResult> {
  return { mode: "transcription", text: "" };
}
