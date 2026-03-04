import Foundation
import SwiftUI
import VellumAssistantShared

/// Channels settings tab — channel configuration and QR pairing UI.
/// This is the single source of truth for configuring how devices
/// and integrations reach this Mac.
@MainActor
struct SettingsChannelsTab: View {
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?
    private static let smsFeatureFlagKey = "feature_flags.sms.enabled"

    @State private var bearerToken: String = ""
    @State private var tokenRevealed: Bool = false
    @State private var tokenCopied: Bool = false
    @State private var showingPairingQR: Bool = false
    @State private var showingRegenerateConfirmation: Bool = false
    @State private var advancedExpanded: Bool = false
    @State private var isSmsFeatureEnabled: Bool = true

    // Telegram credential entry
    @State private var telegramBotTokenText = ""
    @State private var telegramSetupExpanded = false

    // Twilio credential entry (SMS card)
    @State private var twilioAccountSidText = ""
    @State private var twilioAuthTokenText = ""
    @State private var twilioSetupExpanded = false

    // Twilio credential entry (Voice card)
    @State private var voiceAccountSidText = ""
    @State private var voiceAuthTokenText = ""
    @State private var voiceSetupExpanded = false


    // Slack channel credential entry
    @State private var slackChannelSetupExpanded = false
    @State private var slackChannelBotTokenInput = ""
    @State private var slackChannelAppTokenInput = ""

    // Email copy state
    @State private var emailCopied: Bool = false

    // Guardian copy state (tracks which channel's command was just copied)
    @State private var guardianCommandCopiedChannel: String?

    // Outbound guardian verification destination input (keyed by channel)
    @State private var guardianDestinationText: [String: String] = [:]

    // Outbound verification code copy state (tracks which channel's code was just copied)
    @State private var outboundCodeCopiedChannel: String?

    // Countdown timer for outbound verification expiry (ref-counted so
    // closing one channel row doesn't stop the timer for remaining rows)
    @State private var countdownNow: Date = Date()
    @State private var countdownTimer: Timer?
    @State private var countdownTimerRefCount: Int = 0

    // Shared label column width for channelStatusRow and guardianLabel alignment
    private let labelColumnWidth: CGFloat = 140

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            connectionsSection
        }
        .onAppear {
            store.refreshAssistantEmail()
            store.refreshApprovedDevices()
            refreshBearerToken()
            store.refreshChannelGuardianStatus(channel: "telegram")
            store.refreshChannelGuardianStatus(channel: "voice")
            store.refreshChannelGuardianStatus(channel: "slack")
            store.refreshTelegramApprovedMembers()
            store.fetchSlackChannelConfig()
            if store.twilioHasCredentials {
                store.refreshTwilioNumbers()
            }
            Task {
                await loadSmsFeatureFlag()
                if isSmsFeatureEnabled {
                    store.refreshChannelGuardianStatus(channel: "sms")
                }
            }
        }
        .onChange(of: store.twilioHasCredentials) { _, hasCredentials in
            if !hasCredentials {
                twilioSetupExpanded = false
                voiceSetupExpanded = false
            } else {
                store.refreshTwilioNumbers()
            }
        }
        .alert("Regenerate Bearer Token", isPresented: $showingRegenerateConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Regenerate", role: .destructive) {
                regenerateHttpToken()
            }
        } message: {
            Text("This will generate a new security token and restart your assistant. Any paired devices will need to reconnect.")
        }
        .sheet(isPresented: $showingPairingQR) {
            PairingQRCodeSheet(
                gatewayUrl: store.resolvedIosGatewayUrl,
                daemonClient: daemonClient
            )
        }
    }

    // MARK: - Bearer Token Content

    private var bearerTokenContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Bearer Token")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.textSecondary)

            if bearerToken.isEmpty {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(VColor.warning)
                        .font(.system(size: 12))
                    Text("Bearer token not found. Restart the daemon to generate it.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            } else {
                HStack(spacing: VSpacing.sm) {
                    // Masked or revealed token
                    if tokenRevealed {
                        Text(bearerToken)
                            .font(VFont.mono)
                            .foregroundColor(VColor.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    } else {
                        Text(String(repeating: "\u{2022}", count: min(bearerToken.count, 24)))
                            .font(VFont.mono)
                            .foregroundColor(VColor.textPrimary)
                            .lineLimit(1)
                    }

                    Spacer()

                    // Reveal/hide toggle
                    Button {
                        tokenRevealed.toggle()
                    } label: {
                        Image(systemName: tokenRevealed ? "eye.slash" : "eye")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(VColor.textSecondary)
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(tokenRevealed ? "Hide token" : "Reveal token")
                    .help(tokenRevealed ? "Hide token" : "Reveal token")

                    // Copy button
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(bearerToken, forType: .string)
                        tokenCopied = true
                        Task {
                            try? await Task.sleep(nanoseconds: 2_000_000_000)
                            tokenCopied = false
                        }
                    } label: {
                        Image(systemName: tokenCopied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(tokenCopied ? VColor.success : VColor.textSecondary)
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Copy bearer token")
                    .help("Copy token")

                }

                VButton(label: "Regenerate", style: .tertiary) {
                    showingRegenerateConfirmation = true
                }
            }
        }
    }

    // MARK: - Connections Section

    private var connectionsSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            mobileCard
            telegramCard
            slackChannelCard
            voiceCard
            if isSmsFeatureEnabled {
                twilioCard
            }
            emailCard
        }
    }

    // MARK: - Email Channel Card

    private var emailCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Email")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Text("Send and receive emails as your assistant")
                    .font(VFont.sectionDescription)
                    .foregroundColor(VColor.textMuted)
            }

            if let email = store.assistantEmail {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                        .font(.system(size: 14))
                    Text(email)
                        .font(VFont.mono)
                        .foregroundColor(VColor.textPrimary)
                        .textSelection(.enabled)
                    Spacer()
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(email, forType: .string)
                        emailCopied = true
                        Task {
                            try? await Task.sleep(nanoseconds: 2_000_000_000)
                            emailCopied = false
                        }
                    } label: {
                        Image(systemName: emailCopied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(emailCopied ? VColor.success : VColor.textSecondary)
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Copy email address")
                    .help("Copy email address")
                }
            } else {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundColor(VColor.warning)
                        .font(.system(size: 12))
                    Text("Not configured — run the Email Setup skill to assign an address")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Telegram Channel Card

    private var telegramCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Telegram")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Text("Message your assistant from Telegram")
                    .font(VFont.sectionDescription)
                    .foregroundColor(VColor.textMuted)
            }

            // Bot credential row
            if store.telegramHasBotToken {
                HStack(spacing: VSpacing.sm) {
                    VButton(label: "Connected", leftIcon: "checkmark.circle.fill", style: .success) {}
                    VButton(label: "Disconnect", style: .danger, isDisabled: store.telegramSaveInProgress) {
                        store.clearTelegramCredentials()
                        telegramBotTokenText = ""
                        telegramSetupExpanded = false
                    }
                }
            } else if telegramSetupExpanded {
                telegramCredentialEntry
            } else {
                VButton(label: "Set Up", style: .secondary) {
                    telegramSetupExpanded = true
                }
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

            // Approved users (only when bot token exists and guardian is verified)
            if store.telegramHasBotToken && store.telegramGuardianVerified {
                Divider().background(VColor.surfaceBorder)
                telegramApprovedUsersSection
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Telegram Approved Users

    private var telegramApprovedUsersSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.xs) {
                Text("Approved Users")
                VInfoTooltip("Users who have been granted access to interact with your assistant via Telegram.")
            }
            .font(VFont.caption)
            .foregroundColor(VColor.textSecondary)

            if store.telegramApprovedMembersLoading {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            } else if store.telegramApprovedMembers.isEmpty {
                Text("No approved users.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            } else {
                ForEach(store.telegramApprovedMembers) { member in
                    HStack(spacing: VSpacing.sm) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(member.displayName ?? member.username ?? member.externalUserId ?? member.id)
                                .font(VFont.body)
                                .foregroundColor(VColor.textPrimary)
                                .lineLimit(1)
                            if let username = member.username, member.displayName != nil {
                                Text("@\(username)")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.textMuted)
                                    .lineLimit(1)
                            }
                        }
                        Spacer()
                        VButton(label: "Revoke", style: .secondary) {
                            store.revokeTelegramApprovedMember(memberId: member.id)
                        }
                        .disabled(store.telegramRevokingMemberIds.contains(member.id))
                    }
                }
            }

            if let error = store.telegramApprovedMembersError {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }
        }
    }

    // MARK: - Telegram Credential Entry

    private var telegramCredentialEntry: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Bot Token")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.textSecondary)

            SecureField("Telegram bot token", text: $telegramBotTokenText)
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)

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
                HStack(spacing: VSpacing.sm) {
                    VButton(label: "Connect", style: .secondary) {
                        store.saveTelegramToken(botToken: telegramBotTokenText)
                        telegramBotTokenText = ""
                        telegramSetupExpanded = false
                    }
                    .disabled(telegramBotTokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    VButton(label: "Cancel", style: .tertiary) {
                        telegramSetupExpanded = false
                        telegramBotTokenText = ""
                    }
                }
            }
        }
    }

    // MARK: - Slack Channel Card

    private var slackChannelCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Slack")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Text("Message your assistant from Slack")
                    .font(VFont.sectionDescription)
                    .foregroundColor(VColor.textMuted)
            }

            if store.slackChannelHasBotToken && store.slackChannelHasAppToken {
                HStack(spacing: VSpacing.sm) {
                    VButton(label: "Connected", leftIcon: "checkmark.circle.fill", style: .success) {}
                    VButton(label: "Disconnect", style: .danger, isDisabled: store.slackChannelSaveInProgress) {
                        store.clearSlackChannelConfig()
                        slackChannelBotTokenInput = ""
                        slackChannelAppTokenInput = ""
                        slackChannelSetupExpanded = false
                    }
                }
            } else if slackChannelSetupExpanded {
                slackChannelCredentialEntry
            } else {
                VButton(label: "Set Up", style: .secondary) {
                    slackChannelSetupExpanded = true
                }
            }

            if let error = store.slackChannelError {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }

            // Guardian row (only when bot token and app token are configured)
            if store.slackChannelHasBotToken && store.slackChannelHasAppToken {
                Divider().background(VColor.surfaceBorder)
                guardianStatusRow(channel: "slack")
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Slack Channel Credential Entry

    private var slackChannelCredentialEntry: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Slack Credentials")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.textSecondary)

            SecureField("Bot Token (xoxb-...)", text: $slackChannelBotTokenInput)
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)

            SecureField("App Token (xapp-...)", text: $slackChannelAppTokenInput)
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)

            Text("Create a Slack app with Socket Mode enabled to get these tokens")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            if store.slackChannelSaveInProgress {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Saving...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            } else {
                HStack(spacing: VSpacing.sm) {
                    VButton(label: "Connect", style: .secondary) {
                        store.saveSlackChannelConfig(
                            botToken: slackChannelBotTokenInput,
                            appToken: slackChannelAppTokenInput
                        )
                        slackChannelBotTokenInput = ""
                        slackChannelAppTokenInput = ""
                        slackChannelSetupExpanded = false
                    }
                    .disabled(
                        slackChannelBotTokenInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || slackChannelAppTokenInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
                    VButton(label: "Cancel", style: .tertiary) {
                        slackChannelSetupExpanded = false
                        slackChannelBotTokenInput = ""
                        slackChannelAppTokenInput = ""
                    }
                }
            }
        }
    }

    // MARK: - SMS (Twilio) Channel Card

    private var twilioCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("SMS")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Text("Text your assistant using Twilio as the SMS provider")
                    .font(VFont.sectionDescription)
                    .foregroundColor(VColor.textMuted)
            }

            // Credentials row
            if store.twilioHasCredentials {
                HStack(spacing: VSpacing.sm) {
                    VButton(label: "Connected", leftIcon: "checkmark.circle.fill", style: .success) {}
                    VButton(label: "Disconnect", style: .danger, isDisabled: store.twilioSaveInProgress) {
                        store.clearTwilioCredentials()
                    }
                }
            } else if twilioSetupExpanded {
                twilioCredentialEntry
            } else {
                VButton(label: "Set Up", style: .secondary) {
                    twilioSetupExpanded = true
                }
            }

            // Phone number row (only when credentials exist)
            if store.twilioHasCredentials {
                Divider().background(VColor.surfaceBorder)
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Phone Number")
                        .font(VFont.inputLabel)
                        .foregroundColor(VColor.textSecondary)
                    VDropdown(
                        placeholder: "Not Set",
                        selection: Binding(
                            get: { store.twilioPhoneNumber ?? "" },
                            set: { newValue in
                                store.assignTwilioNumber(phoneNumber: newValue)
                            }
                        ),
                        options: store.twilioNumbers.map { (label: $0.friendlyName, value: $0.phoneNumber) },
                        emptyValue: ""
                    )
                    .frame(maxWidth: 360)
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
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Phone Calling Card

    private var voiceCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Phone Calling")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Text("Receive and make phone calls via Twilio")
                    .font(VFont.sectionDescription)
                    .foregroundColor(VColor.textMuted)
            }

            // Credentials row
            if store.twilioHasCredentials {
                HStack(spacing: VSpacing.sm) {
                    VButton(label: "Connected", leftIcon: "checkmark.circle.fill", style: .success) {}
                    VButton(label: "Disconnect", style: .danger, isDisabled: store.twilioSaveInProgress) {
                        store.clearTwilioCredentials()
                    }
                }
            } else if voiceSetupExpanded {
                voiceCredentialEntry
            } else {
                VButton(label: "Set Up", style: .secondary) {
                    voiceSetupExpanded = true
                }
            }

            // Phone number row (only when credentials exist)
            if store.twilioHasCredentials {
                Divider().background(VColor.surfaceBorder)
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Phone Number")
                        .font(VFont.inputLabel)
                        .foregroundColor(VColor.textSecondary)
                    VDropdown(
                        placeholder: "Not Set",
                        selection: Binding(
                            get: { store.twilioPhoneNumber ?? "" },
                            set: { newValue in
                                store.assignTwilioNumber(phoneNumber: newValue)
                            }
                        ),
                        options: store.twilioNumbers.map { (label: $0.friendlyName, value: $0.phoneNumber) },
                        emptyValue: ""
                    )
                    .frame(maxWidth: 360)
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

            // Guardian row (only when credentials and a phone number are assigned —
            // voice verification initiates an outbound call which requires a valid caller number)
            if store.twilioHasCredentials && store.twilioPhoneNumber != nil {
                Divider().background(VColor.surfaceBorder)
                guardianStatusRow(channel: "voice")
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Twilio Credential Entry

    private var twilioCredentialEntry: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Account SID and Auth Token")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.textSecondary)

            TextField("Account SID", text: $twilioAccountSidText)
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)

            SecureField("Auth Token", text: $twilioAuthTokenText)
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)

            if store.twilioSaveInProgress {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Saving...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            } else {
                HStack(spacing: VSpacing.sm) {
                    VButton(label: "Connect", style: .secondary) {
                        store.saveTwilioCredentials(
                            accountSid: twilioAccountSidText,
                            authToken: twilioAuthTokenText
                        )
                        twilioAccountSidText = ""
                        twilioAuthTokenText = ""
                        twilioSetupExpanded = false
                    }
                    .disabled(
                        twilioAccountSidText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                        twilioAuthTokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
                    VButton(label: "Cancel", style: .tertiary) {
                        twilioSetupExpanded = false
                        twilioAccountSidText = ""
                        twilioAuthTokenText = ""
                    }
                }
            }
        }
    }

    // MARK: - Voice Credential Entry

    private var voiceCredentialEntry: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Account SID and Auth Token")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.textSecondary)

            TextField("Account SID", text: $voiceAccountSidText)
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)

            SecureField("Auth Token", text: $voiceAuthTokenText)
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)

            if store.twilioSaveInProgress {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Saving...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            } else {
                HStack(spacing: VSpacing.sm) {
                    VButton(label: "Connect", style: .secondary) {
                        store.saveTwilioCredentials(
                            accountSid: voiceAccountSidText,
                            authToken: voiceAuthTokenText
                        )
                        voiceAccountSidText = ""
                        voiceAuthTokenText = ""
                        voiceSetupExpanded = false
                    }
                    .disabled(
                        voiceAccountSidText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                        voiceAuthTokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
                    VButton(label: "Cancel", style: .tertiary) {
                        voiceSetupExpanded = false
                        voiceAccountSidText = ""
                        voiceAuthTokenText = ""
                    }
                }
            }
        }
    }

    // MARK: - Channel Status Row

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
        valueURL: URL? = nil,
        action: RowAction? = nil
    ) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                Text(label)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .frame(width: labelColumnWidth, alignment: .leading)

                Image(systemName: icon)
                    .foregroundColor(iconColor)
                    .font(.system(size: 12))

                if let url = valueURL {
                    Link(value, destination: url)
                        .font(valueFont)
                        .lineLimit(1)
                        .onHover { hovering in
                            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                        }
                } else {
                    Text(value)
                        .font(valueFont)
                        .foregroundColor(valueColor)
                        .lineLimit(1)
                }

                Spacer()
            }

            if let action {
                VButton(label: action.label, style: action.style, action: action.action)
                    .disabled(action.disabled)
            }
        }
    }

    // MARK: - Guardian Verification Row

    private var guardianLabel: some View {
        HStack(spacing: VSpacing.xs) {
            Text("Guardian Verification")
            VInfoTooltip("Guardian verification links your account identity for this channel.")
        }
        .font(VFont.caption)
        .foregroundColor(VColor.textSecondary)
        .frame(width: labelColumnWidth, alignment: .leading)
    }

    private func guardianPrimaryIdentity(channel: String, identity: String?) -> String? {
        if channel == "telegram" {
            if let username = store.telegramGuardianUsername?.trimmingCharacters(in: .whitespacesAndNewlines),
               !username.isEmpty {
                return username.hasPrefix("@") ? username : "@\(username)"
            }
            if let displayName = store.telegramGuardianDisplayName?.trimmingCharacters(in: .whitespacesAndNewlines),
               !displayName.isEmpty {
                return displayName
            }
        } else if channel == "sms" {
            if let displayName = store.smsGuardianDisplayName?.trimmingCharacters(in: .whitespacesAndNewlines),
               !displayName.isEmpty {
                return displayName
            }
        } else if channel == "voice" {
            if let displayName = store.voiceGuardianDisplayName?.trimmingCharacters(in: .whitespacesAndNewlines),
               !displayName.isEmpty {
                return displayName
            }
        } else if channel == "slack" {
            if let username = store.slackGuardianUsername?.trimmingCharacters(in: .whitespacesAndNewlines),
               !username.isEmpty {
                return username.hasPrefix("@") ? username : "@\(username)"
            }
            if let displayName = store.slackGuardianDisplayName?.trimmingCharacters(in: .whitespacesAndNewlines),
               !displayName.isEmpty {
                return displayName
            }
        }
        return identity
    }

    private func guardianSecondaryIdentity(primary: String?, identity: String?) -> String? {
        guard let identity = identity?.trimmingCharacters(in: .whitespacesAndNewlines), !identity.isEmpty else {
            return nil
        }
        if let primary {
            let normalizedPrimary = primary.trimmingCharacters(in: .whitespacesAndNewlines)
            if normalizedPrimary.caseInsensitiveCompare(identity) == .orderedSame {
                return nil
            }
        }
        return "ID: \(identity)"
    }

    @ViewBuilder
    private func guardianStatusRow(channel: String) -> some View {
        let identity: String? = {
            switch channel {
            case "telegram": return store.telegramGuardianIdentity
            case "sms": return store.smsGuardianIdentity
            case "voice": return store.voiceGuardianIdentity
            case "slack": return store.slackGuardianIdentity
            default: return nil
            }
        }()
        let verified: Bool = {
            switch channel {
            case "telegram": return store.telegramGuardianVerified
            case "sms": return store.smsGuardianVerified
            case "voice": return store.voiceGuardianVerified
            case "slack": return store.slackGuardianVerified
            default: return false
            }
        }()
        let inProgress: Bool = {
            switch channel {
            case "telegram": return store.telegramGuardianVerificationInProgress
            case "sms": return store.smsGuardianVerificationInProgress
            case "voice": return store.voiceGuardianVerificationInProgress
            case "slack": return store.slackGuardianVerificationInProgress
            default: return false
            }
        }()
        let instruction: String? = {
            switch channel {
            case "telegram": return store.telegramGuardianInstruction
            case "sms": return store.smsGuardianInstruction
            case "voice": return store.voiceGuardianInstruction
            case "slack": return store.slackGuardianInstruction
            default: return nil
            }
        }()
        let error: String? = {
            switch channel {
            case "telegram": return store.telegramGuardianError
            case "sms": return store.smsGuardianError
            case "voice": return store.voiceGuardianError
            case "slack": return store.slackGuardianError
            default: return nil
            }
        }()
        let alreadyBound: Bool = {
            switch channel {
            case "telegram": return store.telegramGuardianAlreadyBound
            case "sms": return store.smsGuardianAlreadyBound
            case "voice": return store.voiceGuardianAlreadyBound
            case "slack": return store.slackGuardianAlreadyBound
            default: return false
            }
        }()
        let outboundSessionId: String? = {
            switch channel {
            case "telegram": return store.telegramOutboundSessionId
            case "sms": return store.smsOutboundSessionId
            case "voice": return store.voiceOutboundSessionId
            case "slack": return store.slackOutboundSessionId
            default: return nil
            }
        }()
        let outboundExpiresAt: Date? = {
            switch channel {
            case "telegram": return store.telegramOutboundExpiresAt
            case "sms": return store.smsOutboundExpiresAt
            case "voice": return store.voiceOutboundExpiresAt
            case "slack": return store.slackOutboundExpiresAt
            default: return nil
            }
        }()
        let outboundNextResendAt: Date? = {
            switch channel {
            case "telegram": return store.telegramOutboundNextResendAt
            case "sms": return store.smsOutboundNextResendAt
            case "voice": return store.voiceOutboundNextResendAt
            case "slack": return store.slackOutboundNextResendAt
            default: return nil
            }
        }()
        let outboundSendCount: Int = {
            switch channel {
            case "telegram": return store.telegramOutboundSendCount
            case "sms": return store.smsOutboundSendCount
            case "voice": return store.voiceOutboundSendCount
            case "slack": return store.slackOutboundSendCount
            default: return 0
            }
        }()
        let bootstrapUrl: String? = channel == "telegram" ? store.telegramBootstrapUrl : nil
        let outboundCode: String? = {
            switch channel {
            case "telegram": return store.telegramOutboundCode
            case "sms": return store.smsOutboundCode
            case "voice": return store.voiceOutboundCode
            case "slack": return store.slackOutboundCode
            default: return nil
            }
        }()
        let primaryIdentity = guardianPrimaryIdentity(channel: channel, identity: identity)
        let secondaryIdentity = guardianSecondaryIdentity(primary: primaryIdentity, identity: identity)
        let telegramProfileURL: URL? = channel == "telegram"
            ? identity.flatMap { URL(string: "https://web.telegram.org/a/#\($0)") }
            : nil

        VStack(alignment: .leading, spacing: VSpacing.sm) {
            if verified {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    HStack(spacing: VSpacing.sm) {
                        guardianLabel
                        VStack(alignment: .leading, spacing: 2) {
                            if let telegramProfileURL {
                                Link(primaryIdentity ?? "Verified", destination: telegramProfileURL)
                                    .font(VFont.body)
                                    .lineLimit(1)
                                    .onHover { hovering in
                                        if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                                    }
                            } else {
                                Text(primaryIdentity ?? "Verified")
                                    .font(VFont.body)
                                    .foregroundColor(VColor.textSecondary)
                                    .lineLimit(1)
                            }
                            if let secondaryIdentity {
                                if let telegramProfileURL {
                                    Link(secondaryIdentity, destination: telegramProfileURL)
                                        .font(VFont.caption)
                                        .lineLimit(1)
                                        .onHover { hovering in
                                            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                                        }
                                } else {
                                    Text(secondaryIdentity)
                                        .font(VFont.caption)
                                        .foregroundColor(VColor.textMuted)
                                        .lineLimit(1)
                                }
                            }
                        }
                        Spacer()
                    }
                    VButton(label: "Revoke", style: .secondary) {
                        store.revokeChannelGuardian(channel: channel)
                    }
                }
            } else if inProgress && outboundSessionId == nil {
                HStack(spacing: VSpacing.sm) {
                    guardianLabel
                    ProgressView()
                        .controlSize(.small)
                    Text("Sending verification...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            } else if outboundSessionId != nil {
                guardianOutboundPendingView(
                    channel: channel,
                    expiresAt: outboundExpiresAt,
                    nextResendAt: outboundNextResendAt,
                    sendCount: outboundSendCount,
                    bootstrapUrl: bootstrapUrl,
                    outboundCode: outboundCode
                )
            } else if let instruction {
                guardianInstructionView(channel: channel, instruction: instruction)
            } else {
                guardianDestinationInputView(channel: channel)
            }

            if let error {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(error)
                        .font(VFont.caption)
                        .foregroundColor(VColor.error)
                    if alreadyBound {
                        VButton(label: "Replace", style: .secondary) {
                            store.startChannelGuardianVerification(channel: channel, rebind: true)
                        }
                    }
                }
                .padding(.leading, labelColumnWidth + VSpacing.sm)
            }
        }
    }

    // MARK: - Outbound Guardian Destination Input

    @ViewBuilder
    private func guardianDestinationInputView(channel: String) -> some View {
        let destinationBinding = Binding<String>(
            get: { guardianDestinationText[channel] ?? "" },
            set: { guardianDestinationText[channel] = $0 }
        )
        let destination = destinationBinding.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let placeholder: String = {
            switch channel {
            case "telegram": return "@username or chat ID"
            case "sms", "voice": return "+1234567890"
            case "slack": return "Slack user ID"
            default: return "Destination"
            }
        }()

        VStack(alignment: .leading, spacing: VSpacing.md) {
            guardianLabel

            TextField(placeholder, text: destinationBinding)
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .frame(maxWidth: 360)

            if channel == "telegram" {
                HStack(spacing: 0) {
                    Text("Enter a @username or chat ID. ")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)

                    Button {
                        if let url = URL(string: "https://web.telegram.org/k/#@userinfobot") {
                            NSWorkspace.shared.open(url)
                        }
                    } label: {
                        Text("Find yours →")
                            .font(VFont.caption)
                            .foregroundColor(VColor.accent)
                    }
                    .buttonStyle(.plain)
                    .onHover { hovering in
                        if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                    }
                }
            } else if channel == "voice" || channel == "sms" {
                Text("This is your personal phone number")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }

            VButton(label: "Send", style: .secondary) {
                store.startOutboundGuardianVerification(channel: channel, destination: destination)
            }
            .disabled(destination.isEmpty)
        }
    }

    // MARK: - Outbound Guardian Pending View

    @ViewBuilder
    private func guardianOutboundPendingView(
        channel: String,
        expiresAt: Date?,
        nextResendAt: Date?,
        sendCount: Int,
        bootstrapUrl: String?,
        outboundCode: String?
    ) -> some View {
        let isCodeCopied = outboundCodeCopiedChannel == channel
        let canResend: Bool = {
            // Bootstrap sessions (Telegram handle-based) don't support resend
            if bootstrapUrl != nil { return false }
            guard let nextResendAt else { return true }
            return countdownNow >= nextResendAt
        }()
        let resendCooldownText: String? = {
            guard let nextResendAt, countdownNow < nextResendAt else { return nil }
            let remaining = Int(nextResendAt.timeIntervalSince(countdownNow))
            return "Resend in \(remaining)s"
        }()

        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                guardianLabel
                Spacer()
            }

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                // Verification Code label + code box
                if let outboundCode {
                    HStack(spacing: VSpacing.xs) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(VColor.success)
                            .font(.system(size: 12))
                        Text("Verification Code Sent")
                            .font(VFont.caption)
                            .foregroundColor(VColor.success)
                    }

                    HStack(spacing: VSpacing.sm) {
                        Text(outboundCode)
                            .font(VFont.mono)
                            .foregroundColor(VColor.textPrimary)
                            .textSelection(.enabled)
                            .lineLimit(1)

                        Spacer()

                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(outboundCode, forType: .string)
                            outboundCodeCopiedChannel = channel
                            // Use GCD instead of Task to avoid Swift concurrency executor
                            // tracking issues when the countdown timer rebuilds this view.
                            let copiedChannel = channel
                            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                                if outboundCodeCopiedChannel == copiedChannel {
                                    outboundCodeCopiedChannel = nil
                                }
                            }
                        } label: {
                            HStack(spacing: VSpacing.xs) {
                                Image(systemName: isCodeCopied ? "checkmark" : "doc.on.doc")
                                    .font(.system(size: 12, weight: .medium))
                                Text(isCodeCopied ? "Copied" : "Copy")
                                    .font(VFont.caption)
                            }
                            .foregroundColor(isCodeCopied ? VColor.success : VColor.textSecondary)
                            .frame(height: 28)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Copy verification code")
                        .help("Copy code")
                    }
                    .padding(VSpacing.md)
                    .frame(width: 360)
                    .background(VColor.surface)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                    )
                }

                // Send count + countdown in one line
                HStack(spacing: VSpacing.md) {
                    if sendCount > 0 {
                        Text("Sent \(sendCount) time\(sendCount == 1 ? "" : "s")")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                    if let expiresAt {
                        let remaining = expiresAt.timeIntervalSince(countdownNow)
                        if remaining > 0 {
                            let minutes = Int(remaining) / 60
                            let seconds = Int(remaining) % 60
                            Text("Expires in \(minutes):\(String(format: "%02d", seconds))")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        } else {
                            Text("Verification expired")
                                .font(VFont.caption)
                                .foregroundColor(VColor.error)
                        }
                    }
                }

                // Resend + Cancel in one line
                // Disable resend during bootstrap: when bootstrapUrl is set the session is
                // in pending_bootstrap state and the daemon rejects resend attempts.
                HStack(spacing: VSpacing.sm) {
                    VButton(label: resendCooldownText ?? "Resend", style: .secondary, isFullWidth: true) {
                        store.resendOutboundGuardian(channel: channel)
                    }
                    .disabled(!canResend)
                    .frame(width: 160)

                    VButton(label: "Cancel", style: .tertiary) {
                        store.cancelOutboundGuardian(channel: channel)
                    }
                }

                // Telegram bootstrap URL deep link
                if let bootstrapUrl, let url = URL(string: bootstrapUrl) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Ask your guardian to open this link:")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)

                        Button {
                            NSWorkspace.shared.open(url)
                        } label: {
                            HStack(spacing: VSpacing.xs) {
                                Image(systemName: "arrow.up.right.square")
                                    .font(.system(size: 12))
                                Text("Open in Telegram")
                                    .font(VFont.caption)
                            }
                            .foregroundColor(VColor.accent)
                        }
                        .buttonStyle(.plain)
                        .onHover { hovering in
                            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                        }
                    }
                }
            }
        }
        .onAppear { startCountdownTimer() }
        .onDisappear { stopCountdownTimer() }
    }

    // MARK: - Countdown Timer

    private func startCountdownTimer() {
        countdownTimerRefCount += 1
        guard countdownTimer == nil else { return }
        countdownNow = Date()
        countdownTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            Task { @MainActor in
                countdownNow = Date()
            }
        }
    }

    private func stopCountdownTimer() {
        countdownTimerRefCount = max(countdownTimerRefCount - 1, 0)
        guard countdownTimerRefCount == 0 else { return }
        countdownTimer?.invalidate()
        countdownTimer = nil
    }

    private func guardianInstructionSubtext(channel: String) -> String {
        if channel == "telegram" {
            let handle = store.telegramBotUsername.map { "@\($0)" } ?? "your bot"
            return "Message \(handle) with the below code within the next 10 minutes"
        } else if channel == "voice" {
            let number = store.twilioPhoneNumber ?? "your assistant"
            return "Call \(number) and say the six-digit code below within the next 10 minutes"
        } else {
            let number = store.twilioPhoneNumber ?? "your assistant"
            return "Text \(number) with the below code within the next 10 minutes"
        }
    }

    /// Extracts a guardian verification code from a raw instruction string.
    /// Supports two formats:
    ///   1. "N-digit code: <digits>" (numeric codes, e.g. "6-digit code: 123456")
    ///   2. "the code: <hex>" (high-entropy hex codes for inbound challenges)
    private func extractGuardianCommand(from instruction: String) -> String? {
        // Try N-digit code format (e.g., "6-digit code: 123456")
        if let code = extractNumericCode(from: instruction) {
            return code
        }
        // Try generic "the code: <hex>" format for high-entropy codes
        if let range = instruction.range(of: #"the code:\s*([0-9a-fA-F]+)"#, options: .regularExpression) {
            let match = String(instruction[range])
            if let hexRange = match.range(of: #"[0-9a-fA-F]{6,}"#, options: .regularExpression) {
                return String(match[hexRange])
            }
        }
        return nil
    }

    /// Extracts a numeric verification code from instruction text.
    /// Matches the format "N-digit code: <digits>" used for identity-bound codes.
    private func extractNumericCode(from instruction: String) -> String? {
        guard let range = instruction.range(of: #"\d+-digit code:\s*(\d+)"#, options: .regularExpression) else {
            return nil
        }
        let match = String(instruction[range])
        // Extract just the digits after "N-digit code: "
        guard let colonRange = match.range(of: #":\s*"#, options: .regularExpression) else {
            return nil
        }
        return String(match[colonRange.upperBound...])
    }

    @ViewBuilder
    private func guardianInstructionView(channel: String, instruction: String) -> some View {
        // All channels now use code-only verification. extractGuardianCommand
        // handles both "six-digit code: 123456" and "the code: <hex>" formats.
        let command: String? = extractGuardianCommand(from: instruction)
        let isCopied = guardianCommandCopiedChannel == channel

        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                guardianLabel
                Text("Verification pending")
                    .font(VFont.body)
                    .foregroundColor(VColor.warning)
                Spacer()
            }

            if let command {
                Text(guardianInstructionSubtext(channel: channel))
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .padding(.leading, labelColumnWidth + VSpacing.sm)

                HStack(spacing: VSpacing.sm) {
                    Text(command)
                        .font(VFont.mono)
                        .foregroundColor(VColor.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)

                    Spacer()

                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(command, forType: .string)
                        guardianCommandCopiedChannel = channel
                        Task {
                            try? await Task.sleep(nanoseconds: 2_000_000_000)
                            if guardianCommandCopiedChannel == channel {
                                guardianCommandCopiedChannel = nil
                            }
                        }
                    } label: {
                        HStack(spacing: VSpacing.xs) {
                            Image(systemName: isCopied ? "checkmark" : "doc.on.doc")
                                .font(.system(size: 12, weight: .medium))
                            Text(isCopied ? "Copied" : "Copy")
                                .font(VFont.caption)
                        }
                        .foregroundColor(isCopied ? VColor.success : VColor.textSecondary)
                        .frame(height: 28)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Copy verification command")
                    .help("Copy command")
                }
                .padding(VSpacing.md)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                )
                .padding(.leading, labelColumnWidth + VSpacing.sm)
            } else {
                // Fallback: show raw instruction if command can't be parsed
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
                    .padding(.leading, labelColumnWidth + VSpacing.sm)
            }

            VButton(label: "Cancel", style: .tertiary) {
                store.cancelGuardianChallenge(channel: channel)
            }
        }
    }

    // MARK: - Mobile Card (Pairing + Approved Devices)

    private var mobileCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Mobile (iOS)")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Text("Connect your phone to your assistant through the iOS app")
                    .font(VFont.sectionDescription)
                    .foregroundColor(VColor.textMuted)
            }

            // Connected devices
            if !store.approvedDevices.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Devices")
                        .font(VFont.inputLabel)
                        .foregroundColor(VColor.textSecondary)

                    ForEach(store.approvedDevices, id: \.hashedDeviceId) { device in
                        HStack(spacing: VSpacing.sm) {
                            Image(systemName: "iphone")
                                .foregroundColor(VColor.success)
                                .font(.system(size: 12))
                            Text(device.deviceName)
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                            Button {
                                store.removeApprovedDevice(hashedDeviceId: device.hashedDeviceId)
                            } label: {
                                Image(systemName: "trash")
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundColor(VColor.error)
                                    .padding(VSpacing.xs)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove \(device.deviceName)")
                            .onHover { hovering in
                                if hovering { NSCursor.pointingHand.set() } else { NSCursor.arrow.set() }
                            }
                        }
                    }
                }
            }

            // Device pairing row — mirrors Guardian Verification row layout
            mobilePairingRow

            // Compact advanced disclosure for power users
            Divider().background(VColor.surfaceBorder)

            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(VAnimation.fast) {
                        advancedExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: VSpacing.xs) {
                        Text("Advanced")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundColor(VColor.textMuted)
                            .rotationEffect(.degrees(advancedExpanded ? 90 : 0))
                            .animation(VAnimation.fast, value: advancedExpanded)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if advancedExpanded {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        bearerTokenContent
                    }
                    .padding(.top, VSpacing.sm)
                }
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var mobilePairingRow: some View {
        let hasGateway = !store.resolvedIosGatewayUrl.isEmpty || LANIPHelper.currentLANAddress() != nil
        let hasToken = !bearerToken.isEmpty

        if store.isRegeneratingToken {
            HStack(spacing: VSpacing.sm) {
                ProgressView()
                    .controlSize(.small)
                Text("Restarting daemon\u{2026}")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }
        } else if !hasGateway {
            HStack(spacing: VSpacing.sm) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundColor(VColor.warning)
                    .font(.system(size: 12))
                Text("Configure a gateway URL to enable pairing")
                    .font(VFont.body)
                    .foregroundColor(VColor.warning)
            }
        } else if !hasToken {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(VColor.warning)
                        .font(.system(size: 12))
                    Text("Bearer token required")
                        .font(VFont.body)
                        .foregroundColor(VColor.warning)
                }
                VButton(label: "Generate Token", style: .secondary) {
                    regenerateHttpToken()
                }
            }
        } else {
            VButton(label: "Pair Device", leftIcon: "qrcode", style: .primary) {
                showingPairingQR = true
            }
        }
    }


    // MARK: - Token Helpers

    private func loadSmsFeatureFlag() async {
        // Primary source: gateway feature-flags API.
        if let daemonClient {
            do {
                let flags = try await daemonClient.getFeatureFlags()
                if let smsFlag = flags.first(where: { $0.key == Self.smsFeatureFlagKey }) {
                    isSmsFeatureEnabled = smsFlag.enabled
                    return
                }
            } catch {
                // Fall through to local config fallback.
            }
        }

        // Fallback: local workspace config values.
        let config = WorkspaceConfigIO.read()
        if let canonicalFlags = config["assistantFeatureFlagValues"] as? [String: Bool],
           let enabled = canonicalFlags[Self.smsFeatureFlagKey] {
            isSmsFeatureEnabled = enabled
            return
        }

        // No legacy `skills.*` fallback in new production code. If canonical
        // values are absent, keep the default enabled behavior.
    }

    private func refreshBearerToken() {
        bearerToken = readHttpToken() ?? ""
    }

    private func regenerateHttpToken() {
        let tokenPath = resolveHttpTokenPath()
        // Generate new random bytes before deleting the old file so a
        // SecRandomCopyBytes failure doesn't leave us with no token at all.
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return }
        let newToken = bytes.map { String(format: "%02x", $0) }.joined()
        try? FileManager.default.removeItem(atPath: tokenPath)
        let dir = (tokenPath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: tokenPath, contents: Data(newToken.utf8), attributes: [.posixPermissions: 0o600])
        bearerToken = newToken
        // Kill the daemon so the health monitor restarts it with the new token.
        // The daemon only reads the token at startup, so a restart is required.
        store.isRegeneratingToken = true
        let pidPath = resolvePidPath()
        if let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           let pid = Int32(pidStr) {
            kill(pid, SIGTERM)
        }
        // Wait for the daemon to restart and become reachable with the new token.
        Task {
            let base = store.localGatewayTarget.hasSuffix("/")
                ? String(store.localGatewayTarget.dropLast())
                : store.localGatewayTarget
            guard let url = URL(string: "\(base)/v1/health") else {
                store.isRegeneratingToken = false
                return
            }
            var request = URLRequest(url: url)
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            request.timeoutInterval = 2
            for _ in 0..<30 { // up to ~30s
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if let (_, response) = try? await URLSession.shared.data(for: request),
                   let http = response as? HTTPURLResponse, http.statusCode == 200 {
                    store.isRegeneratingToken = false
                    return
                }
            }
            store.isRegeneratingToken = false
        }
    }
}
