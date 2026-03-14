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
    var isEmailEnabled: Bool = false

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


    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Assistant Channels")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.contentDefault)
                    Text("Once set up, you and others you trust can talk to your assistant in these channels.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }

                telegramCard
                slackChannelCard
                voiceCard
                if isEmailEnabled {
                    emailCard
                }
            }
            .padding(VSpacing.lg)
        }
        .onAppear {
            store.fetchChannelSetupStatus()
            if isEmailEnabled {
                store.refreshAssistantEmail()
            }
            store.refreshChannelVerificationStatus(channel: "telegram")
            store.refreshChannelVerificationStatus(channel: "phone")
            store.refreshChannelVerificationStatus(channel: "slack")
            store.fetchSlackChannelConfig()
            if store.twilioHasCredentials {
                store.refreshTwilioNumbers()
            }
        }
        .onChange(of: store.channelSetupStatus["telegram"]) { _, status in
            if status == nil || status == "not_configured" {
                telegramSetupExpanded = false
            }
        }
        .onChange(of: store.channelSetupStatus["slack"]) { _, status in
            if status == nil || status == "not_configured" {
                slackChannelSetupExpanded = false
            }
        }
        .onChange(of: store.channelSetupStatus["phone"]) { _, status in
            if status == nil || status == "not_configured" {
                voiceSetupExpanded = false
            } else if status == "ready" || status == "incomplete" {
                store.refreshTwilioNumbers()
            }
        }
        .onChange(of: isEmailEnabled) { _, enabled in
            if enabled {
                store.refreshAssistantEmail()
            }
        }
    }

    // MARK: - Email Channel Card

    private var emailCard: some View {
        SettingsCard(title: "Email", subtitle: "Send and receive emails as your assistant") {
            if let email = store.assistantEmail {
                HStack(spacing: VSpacing.sm) {
                    VIconView(.circleCheck, size: 14)
                        .foregroundColor(VColor.systemPositiveStrong)
                    Text(email)
                        .font(VFont.mono)
                        .foregroundColor(VColor.contentDefault)
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
                            .foregroundColor(emailCopied ? VColor.systemPositiveStrong : VColor.contentSecondary)
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
                        .foregroundColor(VColor.systemNegativeHover)
                    Text("Not configured — run the Email Setup skill to assign an address")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
            }
        }
    }

    // MARK: - Telegram Channel Card

    private var telegramCard: some View {
        let status = store.channelSetupStatus["telegram"]
        return SettingsCard(title: "Telegram", subtitle: "Message your assistant from Telegram") {
            if status == "ready" {
                VBadge(style: .label("Connected"), color: VColor.systemPositiveStrong)
            }
        } content: {
            if status == "ready" {
                VButton(label: "Disconnect", style: .danger, isDisabled: store.telegramSaveInProgress) {
                    store.clearTelegramCredentials()
                    telegramBotTokenText = ""
                    telegramSetupExpanded = false
                    store.channelSetupStatus["telegram"] = "not_configured"
                }
            } else if (status == "incomplete" && store.telegramHasBotToken) || telegramSetupExpanded {
                telegramCredentialEntry
            } else {
                VButton(label: "Set Up", style: .outlined) {
                    telegramSetupExpanded = true
                }
            }

            if let error = store.telegramError {
                Text(error).font(VFont.caption).foregroundColor(VColor.systemNegativeStrong)
            }

        }
    }

    // MARK: - Telegram Credential Entry

    private var telegramCredentialEntry: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Bot Token")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.contentSecondary)

            SecureField("Telegram bot token", text: $telegramBotTokenText)
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)

            Text("Get your bot token from @BotFather on Telegram")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)

            if store.telegramSaveInProgress {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Saving...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                }
            } else {
                HStack(spacing: VSpacing.sm) {
                    VButton(label: "Connect", style: .outlined, isDisabled: telegramBotTokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                        store.saveTelegramToken(botToken: telegramBotTokenText)
                        telegramBotTokenText = ""
                    }
                    VButton(label: "Cancel", style: .outlined) {
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
                VBadge(style: .label("Connected"), color: VColor.systemPositiveStrong)
            }
        } content: {
            if status == "ready" {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    if let username = store.slackChannelBotUsername {
                        Text("@\(username)")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                            .lineLimit(1)
                    }
                    if let botUserId = store.slackChannelBotUserId {
                        HStack(spacing: 0) {
                            Text("Bot ID: ")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                            if let teamId = store.slackChannelTeamId,
                               let url = URL(string: "slack://user?team=\(teamId)&id=\(botUserId)") {
                                Link(botUserId, destination: url)
                                    .font(VFont.caption)
                                    .lineLimit(1)
                                    .pointerCursor()
                            } else {
                                Text(botUserId)
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.contentTertiary)
                                    .lineLimit(1)
                            }
                        }
                    }
                    VButton(label: "Disconnect", style: .danger, isDisabled: store.slackChannelSaveInProgress) {
                        store.clearSlackChannelConfig()
                        slackChannelBotTokenInput = ""
                        slackChannelAppTokenInput = ""
                        slackChannelSetupExpanded = false
                        store.channelSetupStatus["slack"] = "not_configured"
                    }
                }
            } else if (status == "incomplete" && (store.slackChannelHasBotToken || store.slackChannelHasAppToken)) || slackChannelSetupExpanded {
                slackChannelCredentialEntry
            } else {
                VButton(label: "Set Up", style: .outlined) {
                    slackChannelSetupExpanded = true
                }
            }

            if let error = store.slackChannelError {
                Text(error).font(VFont.caption).foregroundColor(VColor.systemNegativeStrong)
            }

        }
    }

    // MARK: - Slack Channel Credential Entry

    private var slackChannelCredentialEntry: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Slack Credentials")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.contentSecondary)

            SecureField("Bot Token (xoxb-...)", text: $slackChannelBotTokenInput)
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)

            SecureField("App Token (xapp-...)", text: $slackChannelAppTokenInput)
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)

            Text("Create a Slack app with Socket Mode enabled to get these tokens")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)

            if store.slackChannelSaveInProgress {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Saving...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                }
            } else {
                HStack(spacing: VSpacing.sm) {
                    VButton(
                        label: "Connect",
                        style: .outlined,
                        isDisabled: slackChannelBotTokenInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || slackChannelAppTokenInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ) {
                        store.saveSlackChannelConfig(
                            botToken: slackChannelBotTokenInput,
                            appToken: slackChannelAppTokenInput
                        )
                        slackChannelBotTokenInput = ""
                        slackChannelAppTokenInput = ""
                    }
                    VButton(label: "Cancel", style: .outlined) {
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
                VBadge(style: .label("Connected"), color: VColor.systemPositiveStrong)
            }
        } content: {
            // Phone number dropdown: show when credentials are configured
            if (status == "ready" || status == "incomplete") && store.twilioHasCredentials {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Phone Number")
                        .font(VFont.inputLabel)
                        .foregroundColor(VColor.contentSecondary)
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

            if status == "ready" {
                VButton(label: "Disconnect", style: .danger, isDisabled: store.twilioSaveInProgress) {
                    store.clearTwilioCredentials()
                    store.channelSetupStatus["phone"] = "not_configured"
                }
            } else if (status == "incomplete" && store.twilioHasCredentials) || voiceSetupExpanded {
                voiceCredentialEntry
            } else {
                VButton(label: "Set Up", style: .outlined) {
                    voiceSetupExpanded = true
                }
            }

            if let warning = store.twilioWarning {
                Text(warning)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemNegativeHover)
            }

            if let error = store.twilioError {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemNegativeStrong)
            }

        }
    }

    // MARK: - Voice Credential Entry

    private var voiceCredentialEntry: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Account SID and Auth Token")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.contentSecondary)

            TextField("Account SID", text: $voiceAccountSidText)
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)

            SecureField("Auth Token", text: $voiceAuthTokenText)
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)

            if store.twilioSaveInProgress {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Saving...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                }
            } else {
                HStack(spacing: VSpacing.sm) {
                    VButton(
                        label: "Connect",
                        style: .outlined,
                        isDisabled: voiceAccountSidText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                            voiceAuthTokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ) {
                        store.saveTwilioCredentials(
                            accountSid: voiceAccountSidText,
                            authToken: voiceAuthTokenText
                        )
                        voiceAccountSidText = ""
                        voiceAuthTokenText = ""
                    }
                    VButton(label: "Cancel", style: .outlined) {
                        voiceSetupExpanded = false
                        voiceAccountSidText = ""
                        voiceAuthTokenText = ""
                    }
                }
            }
        }
    }

}
