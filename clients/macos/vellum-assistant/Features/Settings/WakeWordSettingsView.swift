import SwiftUI
import VellumAssistantShared

/// Wake word settings tab — enable/disable wake word listening,
/// configure Picovoice access key, sensitivity, and conversation timeout.
struct WakeWordSettingsView: View {
    @AppStorage("wakeWordEnabled") private var wakeWordEnabled: Bool = false
    @AppStorage("wakeWordSensitivity") private var wakeWordSensitivity: Double = 0.5
    @AppStorage("wakeWordTimeoutSeconds") private var wakeWordTimeoutSeconds: Int = 30

    @State private var picovoiceKeyText: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            statusSection
            enableSection
            accessKeySection
            sensitivitySection
            timeoutSection
        }
        .onAppear {
            picovoiceKeyText = APIKeyManager.getKey(for: "picovoice") ?? ""
        }
    }

    // MARK: - Status

    private var statusSection: some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: wakeWordEnabled ? "waveform" : "waveform.slash")
                .font(.system(size: 14))
                .foregroundColor(wakeWordEnabled ? VColor.success : VColor.textMuted)

            Text(wakeWordEnabled ? "Listening for \"hey vellum\"" : "Wake word disabled")
                .font(VFont.body)
                .foregroundColor(wakeWordEnabled ? VColor.textPrimary : VColor.textSecondary)

            Spacer()
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Enable/Disable

    private var enableSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Wake Word")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Enable wake word listening")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Text("Activate the assistant by saying \"hey vellum\" instead of using a keyboard shortcut.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                Spacer()
                Toggle("", isOn: $wakeWordEnabled)
                    .toggleStyle(.switch)
                    .labelsHidden()
                    .accessibilityLabel("Enable wake word listening")
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Access Key

    private var accessKeySection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Picovoice Access Key")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            SecureField("Enter Picovoice access key", text: $picovoiceKeyText)
                .vInputStyle()
                .onSubmit { savePicovoiceKey() }
                .accessibilityLabel("Picovoice access key")

            HStack {
                Text("Required for wake word detection. Get a key at picovoice.ai.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                Spacer()
                VButton(label: "Save", style: .primary) {
                    savePicovoiceKey()
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Sensitivity

    private var sensitivitySection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Sensitivity")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            HStack {
                Text("Detection sensitivity")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                Spacer()
                Text(String(format: "%.1f", wakeWordSensitivity))
                    .font(VFont.mono)
                    .foregroundColor(VColor.textSecondary)
            }

            VSlider(value: $wakeWordSensitivity, range: 0.0...1.0, step: 0.1)

            Text("Higher values make detection more responsive but may increase false activations.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Timeout

    private var timeoutSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Conversation Timeout")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            HStack {
                Text("Auto-end conversation after")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                Spacer()
                Picker("", selection: $wakeWordTimeoutSeconds) {
                    Text("15 seconds").tag(15)
                    Text("30 seconds").tag(30)
                    Text("60 seconds").tag(60)
                    Text("120 seconds").tag(120)
                }
                .pickerStyle(.menu)
                .frame(width: 160)
                .accessibilityLabel("Conversation timeout duration")
            }

            Text("How long to wait for follow-up speech before ending the conversation.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Helpers

    private func savePicovoiceKey() {
        let trimmed = picovoiceKeyText.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            APIKeyManager.deleteKey(for: "picovoice")
        } else {
            APIKeyManager.setKey(trimmed, for: "picovoice")
        }
    }
}
