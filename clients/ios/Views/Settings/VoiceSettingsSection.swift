#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Voice mode settings — listening timeout, TTS provider, and silence detection
/// threshold. These mirror the equivalent options available on macOS.
///
/// The TTS provider picker is registry-driven: providers are loaded from
/// the shared ``TTSProviderRegistry`` so that new providers can be surfaced
/// without adding new enum cases in iOS settings code.
struct VoiceSettingsSection: View {
    /// Seconds of silence that trigger end-of-speech detection. iOS SFSpeechRecognizer
    /// does not have a built-in silence threshold API, so this value controls how long
    /// the InputBarView waits after the last speech activity before stopping the
    /// recognition task automatically. Range 0.5 – 3.0 s.
    @AppStorage(UserDefaultsKeys.voiceSilenceThreshold) private var silenceThreshold: Double = 1.0

    /// Maximum recording duration in seconds before the recogniser is stopped
    /// automatically (listening timeout). A value of 0 means no auto-stop.
    /// Range 5 – 60 s.
    @AppStorage(UserDefaultsKeys.voiceListeningTimeout) private var listeningTimeout: Double = 30.0

    /// Global TTS provider used for all speech features. Persisted as the
    /// provider's string identifier (e.g. `"elevenlabs"`, `"fish-audio"`).
    @AppStorage(UserDefaultsKeys.voiceTTSProvider) private var ttsProviderRaw: String = "elevenlabs"

    /// Registry loaded once from the bundled catalog JSON.
    private let registry = loadTTSProviderRegistry()

    /// Resolved catalog entry for the currently selected provider.
    /// Falls back to the first provider in the registry if the persisted
    /// value does not match any known entry.
    private var selectedProvider: TTSProviderCatalogEntry? {
        registry.provider(withId: ttsProviderRaw) ?? registry.providers.first
    }

    var body: some View {
        Form {
            // MARK: - Listening

            Section {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("Listening Timeout")
                        Spacer()
                        Text(listeningTimeout == 0 ? "Off" : "\(Int(listeningTimeout))s")
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                    Slider(value: $listeningTimeout, in: 5...60, step: 5)
                }
                .padding(.vertical, 4)
            } header: {
                Text("Listening")
            } footer: {
                Text("Maximum recording duration before the microphone stops automatically. Set to 5 s for short commands or up to 60 s for long dictation.")
            }

            // MARK: - Silence Detection

            Section {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("Silence Threshold")
                        Spacer()
                        Text(String(format: "%.1fs", silenceThreshold))
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                    Slider(value: $silenceThreshold, in: 0.5...3.0, step: 0.5)
                }
                .padding(.vertical, 4)
            } header: {
                Text("Silence Detection")
            } footer: {
                Text("How long silence must last before speech is considered finished and the recording stops. Lower values respond faster; higher values give more time for pauses.")
            }

            // MARK: - TTS Provider

            Section {
                Picker("TTS Provider", selection: $ttsProviderRaw) {
                    ForEach(registry.providers, id: \.id) { provider in
                        Text(provider.displayName).tag(provider.id)
                    }
                }
                .pickerStyle(.navigationLink)
            } header: {
                Text("Text-to-Speech")
            } footer: {
                if let provider = selectedProvider {
                    Text(provider.subtitle)
                }
            }
        }
        .navigationTitle("Voice")
        .navigationBarTitleDisplayMode(.inline)
    }
}
#endif
