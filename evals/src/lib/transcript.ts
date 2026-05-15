export interface TranscriptTurn {
  /** simulator = user turn sent to tested agent; assistant = tested agent output. */
  role: "simulator" | "assistant";
  content: string;
  emittedAt: string;
}
