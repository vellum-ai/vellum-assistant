export interface TranscriptTurn {
  /** simulator = user turn sent to tested agent; assistant = tested agent output. */
  role: "simulator" | "assistant";
  content: string;
  emittedAt: string;
  /**
   * Which conversation this turn belongs to. For two-conversation
   * benchmarks (e.g. LongMemEval-V2 ingest → ask), this lets the report
   * UI group turns into separate conversation panes with a dropdown.
   * Omitted on legacy runs that predate the field.
   */
  conversationKey?: string;
}
