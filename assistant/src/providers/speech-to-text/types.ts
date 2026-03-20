export interface SpeechToTextResult {
  text: string;
}

export interface SpeechToTextProvider {
  /**
   * Transcribe audio from a Buffer.
   * @param audio - Raw audio data (WAV, OGG, MP3, etc.)
   * @param mimeType - MIME type of the audio data
   * @param signal - Optional abort signal for cancellation
   */
  transcribe(
    audio: Buffer,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<SpeechToTextResult>;
}
