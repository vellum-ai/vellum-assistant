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

    @State private var showingPairingQR: Bool = false
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

    // Outbound verification destination input (keyed by channel)
    @State private var verificationDestinationText: [String: String] = [:]

    // Countdown timer for outbound verification expiry — only active when
    // at least one channel has an outbound verification session pending
    @State private var countdownNow: Date = Date()
    @State private var countdownTimer: Timer?

    // Shared label column width for channelStatusRow and channel verification alignment
    private let labelColumnWidth: CGFloat = 140

    /// True when at least one channel has an active outbound verification session
    /// that needs the 1-second countdown timer for expiry/resend cooldown display.
    private var hasAnyOutboundSession: Bool {
        store.telegramOutboundSessionId != nil ||
        store.smsOutboundSessionId != nil ||
        store.voiceOutboundSessionId != nil ||
        store.slackOutboundSessionId != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            connectionsSection
        }
        .onAppear {
            store.refreshAssistantEmail()
            store.refreshApprovedDevices()
            store.refreshChannelVerificationStatus(channel: "telegram")
            store.refreshChannelVerificationStatus(channel: "phone")
            store.refreshChannelVerificationStatus(channel: "slack")
            store.refreshTelegramApprovedMembers()
            store.refreshSlackApprovedMembers()
            store.fetchSlackChannelConfig()
            if store.twilioHasCredentials {
                store.refreshTwilioNumbers()
            }
            Task {
                await loadSmsFeatureFlag()
                if isSmsFeatureEnabled {
                    store.refreshChannelVerificationStatus(channel: "sms")
                }
            }
            if hasAnyOutboundSession {
                startCountdownTimer()
            }
        }
        .onDisappear {
            stopCountdownTimer()
        }
        .onChange(of: hasAnyOutboundSession) { _, hasOutbound in
            if hasOutbound {
                startCountdownTimer()
            } else {
                stopCountdownTimer()
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
        .sheet(isPresented: $showingPairingQR) {
            PairingQRCodeSheet(
                gatewayUrl: store.resolvedIosGatewayUrl,
                daemonClient: daemonClient
            )
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
                    VIconView(.circleCheck, size: 14)
                        .foregroundColor(VColor.success)
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
                        VIconView(emailCopied ? .check : .copy, size: 12)
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
                    VIconView(.triangleAlert, size: 12)
                        .foregroundColor(VColor.warning)
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
                    VButton(label: "Connected", leftIcon: VIcon.circleCheck.rawValue, style: .success) {}
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

            // Verification row (only when credentials exist)
            if store.telegramHasBotToken {
                Divider().background(VColor.surfaceBorder)
                channelVerificationView(channel: "telegram")
            }

            // Approved users (only when bot token exists and verification is complete)
            if store.telegramHasBotToken && store.telegramVerificationVerified {
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
                    VButton(label: "Connected", leftIcon: VIcon.circleCheck.rawValue, style: .success) {}
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

            // Verification row (only when bot token and app token are configured)
            if store.slackChannelHasBotToken && store.slackChannelHasAppToken {
                Divider().background(VColor.surfaceBorder)
                channelVerificationView(channel: "slack")

                Divider().background(VColor.surfaceBorder)
                slackApprovedUsersSection
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Slack Approved Users

    private var slackApprovedUsersSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.xs) {
                Text("Approved Users")
                VInfoTooltip("Users who have been granted access to interact with your assistant via Slack.")
            }
            .font(VFont.caption)
            .foregroundColor(VColor.textSecondary)

            if store.slackApprovedMembersLoading {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            } else if store.slackApprovedMembers.isEmpty {
                Text("No approved users.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            } else {
                ForEach(store.slackApprovedMembers) { member in
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
                            store.revokeSlackApprovedMember(memberId: member.id)
                        }
                        .disabled(store.slackRevokingMemberIds.contains(member.id))
                    }
                }
            }

            if let error = store.slackApprovedMembersError {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }
        }
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
                    VButton(label: "Connected", leftIcon: VIcon.circleCheck.rawValue, style: .success) {}
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

            // Verification row (only when credentials exist)
            if store.twilioHasCredentials {
                Divider().background(VColor.surfaceBorder)
                channelVerificationView(channel: "sms")
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
                    VButton(label: "Connected", leftIcon: VIcon.circleCheck.rawValue, style: .success) {}
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

            // Verification row (only when credentials and a phone number are assigned —
            // voice verification initiates an outbound call which requires a valid caller number)
            if store.twilioHasCredentials && store.twilioPhoneNumber != nil {
                Divider().background(VColor.surfaceBorder)
                channelVerificationView(channel: "phone")
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

                VIconView(SFSymbolMapping.icon(forSFSymbol: icon, fallback: .puzzle), size: 12)
                    .foregroundColor(iconColor)

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

    // MARK: - Channel Verification Row

    @ViewBuilder
    private func channelVerificationView(channel: String) -> some View {
        ChannelVerificationFlowView(
            state: store.channelVerificationState(for: channel),
            countdownNow: $countdownNow,
            destinationText: Binding<String>(
                get: { verificationDestinationText[channel] ?? "" },
                set: { verificationDestinationText[channel] = $0 }
            ),
            onStartOutbound: { dest in store.startOutboundVerification(channel: channel, destination: dest) },
            onResend: { store.resendOutboundVerification(channel: channel) },
            onCancelOutbound: { store.cancelOutboundVerification(channel: channel) },
            onRevoke: { store.revokeChannelVerification(channel: channel) },
            onStartSession: { rebind in store.startChannelVerification(channel: channel, rebind: rebind) },
            onCancelSession: { store.cancelVerificationSession(channel: channel) },
            botUsername: store.telegramBotUsername,
            phoneNumber: store.twilioPhoneNumber,
            showLabel: true,
            labelColumnWidth: labelColumnWidth
        )
    }

    // MARK: - Countdown Timer

    private func startCountdownTimer() {
        guard countdownTimer == nil else { return }
        countdownNow = Date()
        countdownTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            Task { @MainActor in
                countdownNow = Date()
            }
        }
    }

    private func stopCountdownTimer() {
        countdownTimer?.invalidate()
        countdownTimer = nil
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
                            VIconView(.smartphone, size: 12)
                                .foregroundColor(VColor.success)
                            Text(device.deviceName)
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                            Button {
                                store.removeApprovedDevice(hashedDeviceId: device.hashedDeviceId)
                            } label: {
                                VIconView(.trash, size: 12)
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

            // Device pairing row — mirrors Channel Verification row layout
            mobilePairingRow
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var mobilePairingRow: some View {
        let hasGateway = !store.resolvedIosGatewayUrl.isEmpty || LANIPHelper.currentLANAddress() != nil

        if !hasGateway {
            HStack(spacing: VSpacing.sm) {
                VIconView(.triangleAlert, size: 12)
                    .foregroundColor(VColor.warning)
                Text("Configure a gateway URL to enable pairing")
                    .font(VFont.body)
                    .foregroundColor(VColor.warning)
            }
        } else {
            VButton(label: "Pair Device", leftIcon: VIcon.qrCode.rawValue, style: .primary) {
                showingPairingQR = true
            }
        }
    }


    // MARK: - Feature Flags

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

}
