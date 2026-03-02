import SwiftUI
import VellumAssistantShared

/// Voice settings tab — configure push-to-talk activation key,
/// enable/disable wake word listening, configure keyword phrase,
/// conversation timeout, and text-to-speech.
struct VoiceSettingsView: View {
    @ObservedObject var store: SettingsStore

    @AppStorage("activationKey") private var activationKey: String = "fn"
    @AppStorage("wakeWordEnabled") private var wakeWordEnabled: Bool = false
    @AppStorage("wakeWordTimeoutSeconds") private var wakeWordTimeoutSeconds: Int = 30
    @AppStorage("wakeWordKeyword") private var wakeWordKeyword: String = "computer"

    @State private var elevenLabsKeyText: String = ""

    private var selectedActivationKey: ActivationKey {
        ActivationKey(rawValue: activationKey) ?? .fn
    }

    private let timeoutOptions: [(label: String, value: Int)] = [
        (label: "5 seconds", value: 5),
        (label: "10 seconds", value: 10),
        (label: "15 seconds", value: 15),
        (label: "30 seconds", value: 30),
        (label: "60 seconds", value: 60),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            pushToTalkCard
            wakeWordCard
            textToSpeechCard
        }
    }

    // MARK: - Push to Talk Card

    private var pushToTalkCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Push to Talk")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Activation key")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Text("Hold this key to dictate text or start a voice conversation.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                Spacer()
                VDropdown(
                    placeholder: "Select key\u{2026}",
                    selection: Binding(
                        get: { selectedActivationKey },
                        set: { activationKey = $0.rawValue }
                    ),
                    options: ActivationKey.allCases.map { (label: $0.displayName, value: $0) }
                )
                .frame(width: 140)
                .accessibilityLabel("Push to talk activation key")
            }

            Divider()
                .background(VColor.surfaceBorder)

            HStack(spacing: VSpacing.sm) {
                Image(systemName: selectedActivationKey != .none ? "checkmark.circle.fill" : "xmark.circle")
                    .foregroundColor(selectedActivationKey != .none ? VColor.success : VColor.textMuted)
                    .font(.system(size: 14))
                Text(selectedActivationKey != .none
                     ? "Active — activation key: \(selectedActivationKey.displayName)"
                     : "Push to talk disabled")
                    .font(VFont.body)
                    .foregroundColor(selectedActivationKey != .none ? VColor.success : VColor.textSecondary)
                Spacer()
            }

            Text("Uses on-device speech recognition — audio never leaves your Mac.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Wake Word Card

    private var wakeWordCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Wake Word")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Enable wake word listening")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Text("Activate the assistant by speaking instead of using a keyboard shortcut.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                Spacer()
                VToggle(isOn: $wakeWordEnabled)
                    .accessibilityLabel("Enable wake word listening")
            }

            Divider()
                .background(VColor.surfaceBorder)

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Keyword")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Text("The word or phrase that triggers listening.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                Spacer()
                TextField("Enter wake word", text: $wakeWordKeyword)
                    .vInputStyle()
                    .frame(width: 180)
                    .accessibilityLabel("Wake word keyword")
            }

            Divider()
                .background(VColor.surfaceBorder)

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Conversation timeout")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Text("How long to wait for follow-up speech before ending the conversation.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                Spacer()
                VDropdown(
                    placeholder: "Select timeout\u{2026}",
                    selection: $wakeWordTimeoutSeconds,
                    options: timeoutOptions
                )
                .frame(width: 140)
                .accessibilityLabel("Conversation timeout duration")
            }

            Divider()
                .background(VColor.surfaceBorder)

            HStack(spacing: VSpacing.sm) {
                Image(systemName: wakeWordEnabled ? "checkmark.circle.fill" : "xmark.circle")
                    .foregroundColor(wakeWordEnabled ? VColor.success : VColor.textMuted)
                    .font(.system(size: 14))
                Text(wakeWordEnabled
                     ? "Listening for \"\(wakeWordKeyword)\""
                     : "Wake word disabled")
                    .font(VFont.body)
                    .foregroundColor(wakeWordEnabled ? VColor.success : VColor.textSecondary)
                Spacer()
            }

            Text("Wake word detection runs entirely on your device using Apple\u{2019}s Speech framework. No audio is stored or transmitted.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Text-to-Speech Card

    private var textToSpeechCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Text-to-Speech")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            if store.hasElevenLabsKey {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                        .font(.system(size: 14))
                    Text(store.maskedElevenLabsKey)
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    VButton(label: "Remove", style: .danger) {
                        store.clearElevenLabsKey()
                        elevenLabsKeyText = ""
                    }
                }
            } else {
                HStack {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("ElevenLabs API Key")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Text("Required for high-quality voice responses during voice conversations.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                    Spacer()
                }

                VInlineActionField(text: $elevenLabsKeyText, placeholder: "Your ElevenLabs API key", isSecure: true) {
                    store.saveElevenLabsKey(elevenLabsKeyText)
                    elevenLabsKeyText = ""
                }
            }

            Divider()
                .background(VColor.surfaceBorder)

            HStack(spacing: VSpacing.sm) {
                Image(systemName: store.hasElevenLabsKey ? "checkmark.circle.fill" : "xmark.circle")
                    .foregroundColor(store.hasElevenLabsKey ? VColor.success : VColor.textMuted)
                    .font(.system(size: 14))
                Text(store.hasElevenLabsKey ? "ElevenLabs API key saved" : "ElevenLabs not configured")
                    .font(VFont.body)
                    .foregroundColor(store.hasElevenLabsKey ? VColor.success : VColor.textSecondary)
                Spacer()
            }

            Text("Your API key is stored securely in the macOS Keychain and is only used to generate voice responses.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
    }
}
