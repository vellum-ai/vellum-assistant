import { getProviderKeyAsync } from "../../security/secure-keys.js";
import { OpenAIWhisperProvider } from "./openai-whisper.js";
import type { SpeechToTextProvider } from "./types.js";

export async function resolveSpeechToTextProvider(): Promise<SpeechToTextProvider | null> {
  const apiKey = await getProviderKeyAsync("openai");
  if (!apiKey) return null;
  return new OpenAIWhisperProvider(apiKey);
}
