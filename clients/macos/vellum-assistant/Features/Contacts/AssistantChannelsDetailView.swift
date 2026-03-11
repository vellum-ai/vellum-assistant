import Foundation
import SwiftUI
import VellumAssistantShared

/// Right-pane detail view that shows the assistant's channel configuration
/// cards (Telegram, Slack, Voice, Email) when the assistant row is selected
/// in the Contacts list.
@MainActor
struct AssistantChannelsDetailView: View {
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?

    // Telegram credential entry
    @State private var telegramBotTokenText = ""
    @State private var telegramSetupExpanded = false

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

    // Countdown timer for outbound verification expiry
    @State private var countdownNow: Date = Date()
    @State private var countdownTimer: Timer?

    // Shared label column width for channelStatusRow and channel verification alignment
    private let labelColumnWidth: CGFloat = 140

    /// True when at least one channel has an active outbound verification session.
    private var hasAnyOutboundSession: Bool {
        store.telegramOutboundSessionId != nil ||
        store.voiceOutboundSessionId != nil ||
        store.slackOutboundSessionId != nil
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                telegramCard
                slackChannelCard
                voiceCard
                emailCard
            }
            .padding(VSpacing.lg)
        }
        .onAppear {
            store.fetchChannelSetupStatus()
            store.refreshAssistantEmail()
            store.refreshChannelVerificationStatus(channel: "telegram")
            store.refreshChannelVerificationStatus(channel: "phone")
            store.refreshChannelVerificationStatus(channel: "slack")
            store.refreshTelegramApprovedMembers()
            store.refreshSlackApprovedMembers()
            store.fetchSlackChannelConfig()
            if store.twilioHasCredentials {
                store.refreshTwilioNumbers()
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
        .onChange(of: store.channelSetupStatus["phone"]) { _, status in
            if status == nil || status == "not_configured" {
                voiceSetupExpanded = false
            } else if status == "ready" || status == "incomplete" {
                store.refreshTwilioNumbers()
            }
        }
    }

    // MARK: - Email Channel Card

    private var emailCard: some View {
        SettingsCard(title: "Email", subtitle: "Send and receive emails as your assistant") {
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
    }

    // MARK: - Telegram Channel Card

    private var telegramCard: some View {
        let status = store.channelSetupStatus["telegram"]
        return SettingsCard(title: "Telegram", subtitle: "Message your assistant from Telegram") {
            if status == "ready" {
                HStack(spacing: VSpacing.sm) {
                    VButton(label: "Connected", leftIcon: VIcon.circleCheck.rawValue, style: .success, size: .medium) {}
                    VButton(label: "Disconnect", style: .danger, size: .medium, isDisabled: store.telegramSaveInProgress) {
                        store.clearTelegramCredentials()
                        telegramBotTokenText = ""
                        telegramSetupExpanded = false
                        store.channelSetupStatus["telegram"] = "not_configured"
                    }
                }
            } else if status == "incomplete" || telegramSetupExpanded {
                telegramCredentialEntry
            } else {
                VButton(label: "Set Up", style: .secondary, size: .medium) {
                    telegramSetupExpanded = true
                }
            }

            if let error = store.telegramError {
                Text(error).font(VFont.caption).foregroundColor(VColor.error)
            }

            if status == "ready" || status == "incomplete" {
                SettingsDivider()
                channelVerificationView(channel: "telegram")
            }

            if (status == "ready" || status == "incomplete") && store.telegramVerificationVerified {
                SettingsDivider()
                telegramApprovedUsersSection
            }
        }
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
                        VButton(label: "Revoke", style: .secondary, size: .medium, isDisabled: store.telegramRevokingMemberIds.contains(member.id)) {
                            store.revokeTelegramApprovedMember(memberId: member.id)
                        }
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
                    VButton(label: "Connect", style: .secondary, size: .medium, isDisabled: telegramBotTokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                        store.saveTelegramToken(botToken: telegramBotTokenText)
                        telegramBotTokenText = ""
                        telegramSetupExpanded = false
                    }
                    VButton(label: "Cancel", style: .tertiary, size: .medium) {
                        telegramSetupExpanded = false
                        telegramBotTokenText = ""
                    }
                }
            }
        }
    }

    // MARK: - Slack Channel Card

    private var slackChannelCard: some View {
        let status = store.channelSetupStatus["slack"]
        return SettingsCard(title: "Slack", subtitle: "Message your assistant from Slack") {
            if status == "ready" {
                HStack(spacing: VSpacing.sm) {
                    VButton(label: "Connected", leftIcon: VIcon.circleCheck.rawValue, style: .success, size: .medium) {}
                    VButton(label: "Disconnect", style: .danger, size: .medium, isDisabled: store.slackChannelSaveInProgress) {
                        store.clearSlackChannelConfig()
                        slackChannelBotTokenInput = ""
                        slackChannelAppTokenInput = ""
                        slackChannelSetupExpanded = false
                        store.channelSetupStatus["slack"] = "not_configured"
                    }
                }
            } else if status == "incomplete" || slackChannelSetupExpanded {
                slackChannelCredentialEntry
            } else {
                VButton(label: "Set Up", style: .secondary, size: .medium) {
                    slackChannelSetupExpanded = true
                }
            }

            if let error = store.slackChannelError {
                Text(error).font(VFont.caption).foregroundColor(VColor.error)
            }

            if status == "ready" || status == "incomplete" {
                SettingsDivider()
                channelVerificationView(channel: "slack")

                SettingsDivider()
                slackApprovedUsersSection
            }
        }
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
                        VButton(label: "Revoke", style: .secondary, size: .medium, isDisabled: store.slackRevokingMemberIds.contains(member.id)) {
                            store.revokeSlackApprovedMember(memberId: member.id)
                        }
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
                    VButton(
                        label: "Connect",
                        style: .secondary,
                        size: .medium,
                        isDisabled: slackChannelBotTokenInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || slackChannelAppTokenInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ) {
                        store.saveSlackChannelConfig(
                            botToken: slackChannelBotTokenInput,
                            appToken: slackChannelAppTokenInput
                        )
                        slackChannelBotTokenInput = ""
                        slackChannelAppTokenInput = ""
                        slackChannelSetupExpanded = false
                    }
                    VButton(label: "Cancel", style: .tertiary, size: .medium) {
                        slackChannelSetupExpanded = false
                        slackChannelBotTokenInput = ""
                        slackChannelAppTokenInput = ""
                    }
                }
            }
        }
    }

    // MARK: - Phone Calling Card

    private var voiceCard: some View {
        let status = store.channelSetupStatus["phone"]
        return SettingsCard(title: "Phone Calling", subtitle: "Receive and make phone calls via Twilio") {
            if status == "ready" {
                HStack(spacing: VSpacing.sm) {
                    VButton(label: "Connected", leftIcon: VIcon.circleCheck.rawValue, style: .success, size: .medium) {}
                    VButton(label: "Disconnect", style: .danger, size: .medium, isDisabled: store.twilioSaveInProgress) {
                        store.clearTwilioCredentials()
                        store.channelSetupStatus["phone"] = "not_configured"
                    }
                }
            } else if status == "incomplete" || voiceSetupExpanded {
                voiceCredentialEntry
            } else {
                VButton(label: "Set Up", style: .secondary, size: .medium) {
                    voiceSetupExpanded = true
                }
            }

            // Phone number dropdown: show when at least partially configured
            if status == "ready" || status == "incomplete" {
                SettingsDivider()
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

            if (status == "ready" || status == "incomplete") && store.twilioPhoneNumber != nil {
                SettingsDivider()
                channelVerificationView(channel: "phone")
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
                    VButton(
                        label: "Connect",
                        style: .secondary,
                        size: .medium,
                        isDisabled: voiceAccountSidText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                            voiceAuthTokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ) {
                        store.saveTwilioCredentials(
                            accountSid: voiceAccountSidText,
                            authToken: voiceAuthTokenText
                        )
                        voiceAccountSidText = ""
                        voiceAuthTokenText = ""
                        voiceSetupExpanded = false
                    }
                    VButton(label: "Cancel", style: .tertiary, size: .medium) {
                        voiceSetupExpanded = false
                        voiceAccountSidText = ""
                        voiceAuthTokenText = ""
                    }
                }
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
}
