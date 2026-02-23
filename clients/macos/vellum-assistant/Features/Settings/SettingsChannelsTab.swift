import SwiftUI
import VellumAssistantShared

/// Channels settings tab — Telegram and SMS (Twilio) channel configuration.
/// Displays a compact, status-first layout optimized for viewing and light
/// reconfiguration. Initial setup is handled conversationally by the assistant.
@MainActor
struct SettingsChannelsTab: View {
    @ObservedObject var store: SettingsStore

    // Telegram credential entry
    @State private var telegramBotTokenText = ""
    @State private var telegramSetupExpanded = false

    // Twilio credential entry
    @State private var twilioAccountSidText = ""
    @State private var twilioAuthTokenText = ""
    @State private var twilioSetupExpanded = false

    // Twilio number picker
    @State private var twilioNumberPickerExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            telegramCard
            twilioCard
        }
        .onAppear {
            store.refreshChannelGuardianStatus(channel: "telegram")
            store.refreshChannelGuardianStatus(channel: "sms")
        }
    }

    // MARK: - Telegram Channel Card

    private var telegramCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Telegram")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            // Bot credential row
            if store.telegramHasBotToken {
                channelStatusRow(
                    label: "Bot",
                    icon: "checkmark.circle.fill",
                    iconColor: VColor.success,
                    value: store.telegramBotUsername.map { "@\($0)" } ?? "Configured",
                    action: .init(label: "Clear", style: .danger, disabled: store.telegramSaveInProgress) {
                        store.clearTelegramCredentials()
                        telegramBotTokenText = ""
                        telegramSetupExpanded = false
                    }
                )
            } else if telegramSetupExpanded {
                telegramCredentialEntry
            } else {
                channelStatusRow(
                    label: "Bot",
                    icon: "exclamationmark.triangle",
                    iconColor: VColor.warning,
                    value: "Not configured",
                    valueColor: VColor.textMuted,
                    action: .init(label: "Set Up", style: .secondary) {
                        telegramSetupExpanded = true
                    }
                )
            }

            if let error = store.telegramError {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }

            // Guardian row (only when credentials exist)
            if store.telegramHasBotToken {
                Divider().background(VColor.surfaceBorder)
                guardianStatusRow(channel: "telegram")
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Telegram Credential Entry

    private var telegramCredentialEntry: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                Text("Bot Token")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                Spacer()
                VButton(label: "Cancel", style: .tertiary) {
                    telegramSetupExpanded = false
                    telegramBotTokenText = ""
                }
            }

            SecureField("Telegram bot token", text: $telegramBotTokenText)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.md)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                )

            Text("Get your bot token from @BotFather on Telegram")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            if store.telegramSaveInProgress {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Saving...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            } else {
                VButton(label: "Save", style: .primary) {
                    store.saveTelegramToken(botToken: telegramBotTokenText)
                    telegramBotTokenText = ""
                    telegramSetupExpanded = false
                }
                .disabled(telegramBotTokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    // MARK: - SMS (Twilio) Channel Card

    private var twilioCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("SMS (Twilio)")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            // Credentials row
            if store.twilioHasCredentials {
                channelStatusRow(
                    label: "Credentials",
                    icon: "checkmark.circle.fill",
                    iconColor: VColor.success,
                    value: "Configured",
                    action: .init(label: "Clear", style: .danger, disabled: store.twilioSaveInProgress) {
                        store.clearTwilioCredentials()
                        twilioSetupExpanded = false
                    }
                )
            } else if twilioSetupExpanded {
                twilioCredentialEntry
            } else {
                channelStatusRow(
                    label: "Credentials",
                    icon: "exclamationmark.triangle",
                    iconColor: VColor.warning,
                    value: "Not configured",
                    valueColor: VColor.textMuted,
                    action: .init(label: "Set Up", style: .secondary) {
                        twilioSetupExpanded = true
                    }
                )
            }

            // Phone number row (only when credentials exist)
            if store.twilioHasCredentials {
                Divider().background(VColor.surfaceBorder)

                if twilioNumberPickerExpanded {
                    twilioNumberPicker
                } else {
                    channelStatusRow(
                        label: "Phone Number",
                        icon: store.twilioPhoneNumber != nil ? "phone.fill" : "phone",
                        iconColor: store.twilioPhoneNumber != nil ? VColor.success : VColor.textMuted,
                        value: store.twilioPhoneNumber ?? "Not assigned",
                        valueFont: VFont.mono,
                        valueColor: store.twilioPhoneNumber != nil ? VColor.textPrimary : VColor.textMuted,
                        action: .init(label: "Change", style: .secondary) {
                            twilioNumberPickerExpanded = true
                            if !store.twilioListInProgress {
                                store.refreshTwilioNumbers()
                            }
                        }
                    )
                }
            }

            if let warning = store.twilioWarning {
                Text(warning)
                    .font(VFont.caption)
                    .foregroundColor(VColor.warning)
            }

            if let error = store.twilioError {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }

            // Guardian row (only when credentials exist)
            if store.twilioHasCredentials {
                Divider().background(VColor.surfaceBorder)
                guardianStatusRow(channel: "sms")
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Twilio Credential Entry

    private var twilioCredentialEntry: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                Text("Account SID and Auth Token")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                Spacer()
                VButton(label: "Cancel", style: .tertiary) {
                    twilioSetupExpanded = false
                    twilioAccountSidText = ""
                    twilioAuthTokenText = ""
                }
            }

            TextField("Account SID", text: $twilioAccountSidText)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.md)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                )

            SecureField("Auth Token", text: $twilioAuthTokenText)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.md)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                )

            if store.twilioSaveInProgress {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Saving...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            } else {
                VButton(label: "Save Credentials", style: .primary) {
                    store.saveTwilioCredentials(
                        accountSid: twilioAccountSidText,
                        authToken: twilioAuthTokenText
                    )
                    twilioAuthTokenText = ""
                    twilioSetupExpanded = false
                }
                .disabled(
                    twilioAccountSidText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                    twilioAuthTokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
            }
        }
    }

    // MARK: - Twilio Number Picker

    private var twilioNumberPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                Text("Phone Number")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                Spacer()
                VButton(label: "Cancel", style: .tertiary) {
                    twilioNumberPickerExpanded = false
                }
            }

            if store.twilioListInProgress {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading numbers...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            } else if store.twilioNumbers.isEmpty {
                Text("No phone numbers found on this Twilio account.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            } else {
                ForEach(store.twilioNumbers, id: \.phoneNumber) { number in
                    let isCurrent = number.phoneNumber == store.twilioPhoneNumber
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(number.phoneNumber)
                                .font(VFont.mono)
                                .foregroundColor(VColor.textPrimary)
                            Text(number.friendlyName)
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                        Spacer()
                        if isCurrent {
                            HStack(spacing: VSpacing.xs) {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundColor(VColor.success)
                                    .font(.system(size: 12))
                                Text("Current")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.textSecondary)
                            }
                        } else {
                            VButton(label: "Use", style: .secondary) {
                                store.assignTwilioNumber(phoneNumber: number.phoneNumber)
                                twilioNumberPickerExpanded = false
                            }
                            .disabled(store.twilioSaveInProgress)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Shared Status Row

    private struct RowAction {
        let label: String
        let style: VButton.Style
        var disabled: Bool = false
        let action: () -> Void
    }

    @ViewBuilder
    private func channelStatusRow(
        label: String,
        icon: String,
        iconColor: Color,
        value: String,
        valueFont: Font = VFont.body,
        valueColor: Color = VColor.textSecondary,
        action: RowAction? = nil
    ) -> some View {
        HStack(spacing: VSpacing.sm) {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .frame(width: 90, alignment: .leading)

            Image(systemName: icon)
                .foregroundColor(iconColor)
                .font(.system(size: 12))

            Text(value)
                .font(valueFont)
                .foregroundColor(valueColor)
                .lineLimit(1)

            Spacer()

            if let action {
                VButton(label: action.label, style: action.style, action: action.action)
                    .disabled(action.disabled)
            }
        }
    }

    // MARK: - Guardian Verification Row

    @ViewBuilder
    private func guardianStatusRow(channel: String) -> some View {
        let identity: String? = channel == "telegram" ? store.telegramGuardianIdentity : store.smsGuardianIdentity
        let verified: Bool = channel == "telegram" ? store.telegramGuardianVerified : store.smsGuardianVerified
        let inProgress: Bool = channel == "telegram" ? store.telegramGuardianVerificationInProgress : store.smsGuardianVerificationInProgress
        let instruction: String? = channel == "telegram" ? store.telegramGuardianInstruction : store.smsGuardianInstruction
        let error: String? = channel == "telegram" ? store.telegramGuardianError : store.smsGuardianError

        VStack(alignment: .leading, spacing: VSpacing.sm) {
            if verified {
                channelStatusRow(
                    label: "Guardian",
                    icon: "checkmark.shield.fill",
                    iconColor: VColor.success,
                    value: identity.map { "Verified: \($0)" } ?? "Verified",
                    action: .init(label: "Revoke", style: .danger) {
                        store.revokeChannelGuardian(channel: channel)
                    }
                )
            } else if inProgress {
                HStack(spacing: VSpacing.sm) {
                    Text("Guardian")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .frame(width: 90, alignment: .leading)
                    ProgressView()
                        .controlSize(.small)
                    Text("Generating verification code...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
                Text("You will get a code to send as /guardian_verify <code> from your \(channel == "telegram" ? "Telegram account" : "SMS number").")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .padding(.leading, 90 + VSpacing.sm)
            } else if let instruction {
                HStack(spacing: VSpacing.sm) {
                    Text("Guardian")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .frame(width: 90, alignment: .leading)
                    Text(instruction)
                        .font(VFont.mono)
                        .foregroundColor(VColor.textPrimary)
                        .padding(VSpacing.md)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(VColor.surface)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                        )
                        .textSelection(.enabled)
                }
            } else {
                channelStatusRow(
                    label: "Guardian",
                    icon: "shield.slash",
                    iconColor: VColor.textMuted,
                    value: "Not verified",
                    valueColor: VColor.textMuted,
                    action: .init(label: "Verify", style: .secondary) {
                        store.startChannelGuardianVerification(channel: channel)
                    }
                )
            }

            if let error {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
                    .padding(.leading, 90 + VSpacing.sm)
            }
        }
    }
}

// MARK: - Preview

struct SettingsChannelsTab_Previews: PreviewProvider {
    static var previews: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            ScrollView {
                SettingsChannelsTab(store: SettingsStore())
                    .padding(VSpacing.lg)
            }
        }
        .frame(width: 500, height: 600)
    }
}
