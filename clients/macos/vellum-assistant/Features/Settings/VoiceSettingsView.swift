import SwiftUI
import VellumAssistantShared

/// Voice settings tab — configure push-to-talk activation key,
/// enable/disable wake word listening, configure keyword phrase,
/// and conversation timeout.
struct VoiceSettingsView: View {
    @ObservedObject var store: SettingsStore

    @AppStorage("activationKey") private var activationKey: String = "fn"
    @AppStorage("wakeWordEnabled") private var wakeWordEnabled: Bool = false
    @AppStorage("wakeWordTimeoutSeconds") private var wakeWordTimeoutSeconds: Int = 30
    @AppStorage("wakeWordKeyword") private var wakeWordKeyword: String = "computer"

    @State private var elevenLabsKeyText: String = ""
    @State private var ttsSetupExpanded: Bool = false

    private let suggestedKeywords = ["computer", "jarvis", "hey vellum", "assistant"]

    private var selectedActivationKey: ActivationKey {
        ActivationKey(rawValue: activationKey) ?? .fn
    }

    private var pttEnabled: Bool {
        selectedActivationKey != .none
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            pttCard
            wakeWordCard
            ttsCard
        }
    }

    // MARK: - Push to Talk Card

    private var pttCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Push to Talk")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Text("Hold the activation key to dictate text or start a voice conversation. Uses on-device speech recognition.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Enable Push to Talk")
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                }
                Spacer()
                VToggle(isOn: Binding(
                    get: { pttEnabled },
                    set: { enabled in
                        if enabled {
                            if activationKey == ActivationKey.none.rawValue {
                                activationKey = ActivationKey.fn.rawValue
                            }
                        } else {
                            activationKey = ActivationKey.none.rawValue
                        }
                    }
                ))
                .accessibilityLabel("Enable Push to Talk")
            }

            if pttEnabled {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Activation key")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.textPrimary)

                    VSegmentedControl(
                        items: ActivationKey.allCases.filter { $0 != .none }.map {
                            (label: $0.displayName, tag: $0.rawValue)
                        },
                        selection: $activationKey,
                        style: .pill
                    )
                    .frame(width: 360)
                }
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Wake Word Card

    private var wakeWordCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Talk to Vellum, hands free")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Text("Wake word lets you start a conversation by speaking a keyword aloud \u{2014} no need to click or press anything. It uses on-device speech recognition, so nothing you say ever leaves your Mac.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .lineSpacing(2)
            }

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Enable wake word listening")
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                    Text("Activate the assistant by speaking instead of using a keyboard shortcut.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                Spacer()
                VToggle(isOn: $wakeWordEnabled)
                    .accessibilityLabel("Enable wake word listening")
            }

            if wakeWordEnabled {
                // How it works steps
                HStack(alignment: .top, spacing: VSpacing.md) {
                    wakeWordStepCard(number: "1", title: "Say the keyword", description: "Speak your wake word when you\u{2019}re ready to talk.")
                    wakeWordStepCard(number: "2", title: "Vellum starts listening", description: "A chime plays and your microphone activates.")
                    wakeWordStepCard(number: "3", title: "Ask anything", description: "Speak naturally. Vellum responds when you pause.")
                }

                // Keyword
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Keyword")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.textPrimary)

                    TextField("Enter wake word or phrase", text: $wakeWordKeyword)
                        .vInputStyle()
                        .accessibilityLabel("Wake word keyword")

                    HStack(spacing: VSpacing.sm) {
                        ForEach(suggestedKeywords, id: \.self) { suggestion in
                            Button(suggestion) {
                                wakeWordKeyword = suggestion
                            }
                            .buttonStyle(.plain)
                            .font(VFont.caption)
                            .foregroundColor(wakeWordKeyword == suggestion ? .white : VColor.textMuted)
                            .padding(.horizontal, VSpacing.sm)
                            .padding(.vertical, VSpacing.xs)
                            .background(Capsule().fill(wakeWordKeyword == suggestion ? Forest._700 : VColor.surface))
                            .overlay(Capsule().strokeBorder(wakeWordKeyword == suggestion ? Color.clear : VColor.surfaceBorder, lineWidth: 1))
                        }
                    }
                }

                // Conversation timeout
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Conversation timeout")
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                        Text("How long to wait for follow-up speech before ending the conversation.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                    VDropdown(
                        placeholder: "Select timeout\u{2026}",
                        selection: $wakeWordTimeoutSeconds,
                        options: timeoutOptions
                    )
                    .frame(width: 160)
                    .accessibilityLabel("Conversation timeout duration")
                }

                // Privacy note
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 10))
                        .foregroundColor(VColor.textMuted)
                    Text("Uses on-device speech recognition \u{2014} no data leaves your Mac.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
    }

    private func wakeWordStepCard(number: String, title: String, description: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text(number)
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(VColor.success)
                .frame(width: 24, height: 24)
                .background(Circle().fill(VColor.success.opacity(0.15)))

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(title)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)
                Text(description)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .lineSpacing(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    private let timeoutOptions: [(label: String, value: Int)] = [
        (label: "5 seconds", value: 5),
        (label: "10 seconds", value: 10),
        (label: "15 seconds", value: 15),
        (label: "30 seconds", value: 30),
        (label: "60 seconds", value: 60),
    ]

    // MARK: - Text-to-Speech Card

    private var ttsCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Text-to-Speech")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Text("ElevenLabs provides high-quality voice responses during voice conversations. An API key is required.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }

            if store.hasElevenLabsKey {
                HStack(spacing: VSpacing.sm) {
                    VButton(label: "Connected", leftIcon: "checkmark.circle.fill", style: .success, size: .large) {}
                    VButton(label: "Disconnect", style: .danger, size: .large) {
                        store.clearElevenLabsKey()
                        elevenLabsKeyText = ""
                        ttsSetupExpanded = false
                    }
                }
            } else if ttsSetupExpanded {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("ElevenLabs API Key")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)

                    SecureField("Your ElevenLabs API key", text: $elevenLabsKeyText)
                        .vInputStyle()
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)

                    HStack(spacing: VSpacing.xs) {
                        Image(systemName: "lock.fill")
                            .font(.system(size: 10))
                            .foregroundColor(VColor.textMuted)
                        Text("Your API key is stored securely in the macOS Keychain.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }

                    HStack(spacing: VSpacing.sm) {
                        VButton(label: "Connect", style: .secondary, size: .large) {
                            store.saveElevenLabsKey(elevenLabsKeyText)
                            elevenLabsKeyText = ""
                            ttsSetupExpanded = false
                        }
                        .disabled(elevenLabsKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        VButton(label: "Cancel", style: .tertiary, size: .large) {
                            ttsSetupExpanded = false
                            elevenLabsKeyText = ""
                        }
                    }
                }
            } else {
                VButton(label: "Set Up", style: .secondary, size: .large) {
                    ttsSetupExpanded = true
                }
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
    }
}
