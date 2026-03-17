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
    var assistantName: String = "your assistant"
    var isEmailEnabled: Bool = false
    var showCardBorders: Bool = true

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

    // Disconnect confirmation
    @State private var channelToDisconnect: String? = nil


    var body: some View {
        Group {
            if showCardBorders {
                borderedLayout
            } else {
                flatLayout
            }
        }
        .confirmationDialog(
            "Disconnect \(channelDisplayName(channelToDisconnect))?",
            isPresented: Binding(
                get: { channelToDisconnect != nil },
                set: { if !$0 { channelToDisconnect = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Disconnect", role: .destructive) {
                if let channel = channelToDisconnect {
                    performDisconnect(channel: channel)
                }
                channelToDisconnect = nil
            }
            Button("Cancel", role: .cancel) {
                channelToDisconnect = nil
            }
        } message: {
            Text("This will disconnect the channel. You can set it up again later.")
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

    // MARK: - Layouts

    /// Settings tab layout: individual bordered cards per channel (matches Models & Services layout).
    private var borderedLayout: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            slackChannelCard
            telegramCard
            voiceCard
            if isEmailEnabled {
                emailCard
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Contacts tab layout: compact row list with dividers, no ScrollView (container scrolls).
    private var flatLayout: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Channels")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.contentDefault)
                Text("Manage where \(assistantName) can be reached.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }

            VStack(alignment: .leading, spacing: 0) {
                slackRow
                SettingsDivider()
                telegramRow
                SettingsDivider()
                voiceRow
                if isEmailEnabled {
                    SettingsDivider()
                    emailRow
                }
            }
        }
    }

    // MARK: - Compact Channel Rows (flat layout)

    private var telegramRow: some View {
        let status = store.channelSetupStatus["telegram"]
        return Group {
            if telegramSetupExpanded || (status == "incomplete" && store.telegramHasBotToken) {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    channelRowHeader(name: "Telegram", value: nil, status: nil)
                    telegramCredentialEntry
                }
                .padding(.vertical, VSpacing.sm)
            } else {
                let value: String? = {
                    if status == "ready", let username = store.telegramBotUsername, !username.isEmpty {
                        return "@\(username)"
                    }
                    return nil
                }()
                channelRowHeader(
                    name: "Telegram",
                    channelKey: "telegram",
                    value: value,
                    status: status == "ready" ? .connected : nil,
                    setupAction: status != "ready" ? { telegramSetupExpanded = true } : nil,
                    hasDisconnect: status == "ready",
                    isDisconnectDisabled: store.telegramSaveInProgress
                )
                .padding(.vertical, VSpacing.sm)
            }

            if let error = store.telegramError {
                VInlineMessage(error)
                    .padding(.bottom, VSpacing.sm)
            }
        }
    }

    private var slackRow: some View {
        let status = store.channelSetupStatus["slack"]
        return Group {
            if slackChannelSetupExpanded || (status == "incomplete" && (store.slackChannelHasBotToken || store.slackChannelHasAppToken)) {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    channelRowHeader(name: "Slack", value: nil, status: nil)
                    slackChannelCredentialEntry
                }
                .padding(.vertical, VSpacing.sm)
            } else {
                let value: String? = {
                    if status == "ready", let username = store.slackChannelBotUsername, !username.isEmpty {
                        return "@\(username)"
                    }
                    return nil
                }()
                channelRowHeader(
                    name: "Slack",
                    channelKey: "slack",
                    value: value,
                    status: status == "ready" ? .connected : nil,
                    setupAction: status != "ready" ? { slackChannelSetupExpanded = true } : nil,
                    hasDisconnect: status == "ready",
                    isDisconnectDisabled: store.slackChannelSaveInProgress
                )
                .padding(.vertical, VSpacing.sm)
            }

            if let error = store.slackChannelError {
                VInlineMessage(error)
                    .padding(.bottom, VSpacing.sm)
            }
        }
    }

    private var voiceRow: some View {
        let status = store.channelSetupStatus["phone"]
        return Group {
            if voiceSetupExpanded || (status == "incomplete" && store.twilioHasCredentials) {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    channelRowHeader(name: "Phone Calling", value: nil, status: nil)
                    // Phone number dropdown when credentials exist
                    if store.twilioHasCredentials {
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
                    voiceCredentialEntry
                }
                .padding(.vertical, VSpacing.sm)
            } else if status == "ready" {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    channelRowHeader(
                        name: "Phone Calling",
                        channelKey: "phone",
                        value: store.twilioPhoneNumber,
                        status: .connected,
                        hasDisconnect: true,
                        isDisconnectDisabled: store.twilioSaveInProgress
                    )
                    // Phone number dropdown in connected state
                    if store.twilioHasCredentials {
                        HStack(spacing: VSpacing.sm) {
                            Text("Phone Number")
                                .font(VFont.caption)
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
                            .frame(maxWidth: 280)
                        }
                    }
                }
                .padding(.vertical, VSpacing.sm)
            } else {
                channelRowHeader(
                    name: "Phone Calling",
                    value: nil,
                    status: nil,
                    setupAction: { voiceSetupExpanded = true }
                )
                .padding(.vertical, VSpacing.sm)
            }

            if let warning = store.twilioWarning {
                VInlineMessage(warning, tone: .warning)
                    .padding(.bottom, VSpacing.sm)
            }
            if let error = store.twilioError {
                VInlineMessage(error)
                    .padding(.bottom, VSpacing.sm)
            }
        }
    }

    private var emailRow: some View {
        Group {
            if let email = store.assistantEmail {
                channelRowHeader(
                    name: "Email",
                    value: email,
                    status: .connected
                )
                .padding(.vertical, VSpacing.sm)
            } else {
                channelRowHeader(
                    name: "Email",
                    value: "Not configured",
                    status: nil
                )
                .padding(.vertical, VSpacing.sm)
            }
        }
    }

    // MARK: - Channel Row Header (3-column layout)

    private enum ChannelStatus {
        case connected
    }

    private func channelRowHeader(
        name: String,
        channelKey: String? = nil,
        value: String?,
        status: ChannelStatus?,
        setupAction: (() -> Void)? = nil,
        hasDisconnect: Bool = false,
        isDisconnectDisabled: Bool = false
    ) -> some View {
        ChannelRowHeader(
            name: name,
            channelKey: channelKey,
            value: value,
            status: status,
            setupAction: setupAction,
            hasDisconnect: hasDisconnect,
            isDisconnectDisabled: isDisconnectDisabled,
            onDisconnect: { key in channelToDisconnect = key }
        )
    }

    /// A single channel row with hover-reveal kebab menu for disconnect.
    private struct ChannelRowHeader: View {
        let name: String
        var channelKey: String?
        let value: String?
        let status: ChannelStatus?
        var setupAction: (() -> Void)?
        var hasDisconnect: Bool = false
        var isDisconnectDisabled: Bool = false
        var onDisconnect: ((String) -> Void)?

        @State private var isHovered = false

        var body: some View {
            HStack(spacing: VSpacing.sm) {
                // Left: channel name
                Text(name)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)
                    .frame(width: 100, alignment: .leading)

                // Middle: identity / value
                if let value {
                    Text(value)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                        .lineLimit(1)
                }

                Spacer()

                // Right: status or action
                if let status, status == .connected {
                    VBadge(label: "Connected", tone: .positive)
                } else if let setupAction {
                    VButton(label: "Set up", style: .ghost) {
                        setupAction()
                    }
                }

                // Trailing column — fixed width for alignment across all rows
                Group {
                    if hasDisconnect, let channelKey {
                        Menu {
                            Button(role: .destructive) {
                                onDisconnect?(channelKey)
                            } label: {
                                Label("Disconnect", systemImage: "trash")
                            }
                            .disabled(isDisconnectDisabled)
                        } label: {
                            VIconView(.ellipsis, size: 14)
                                .foregroundColor(VColor.contentTertiary)
                                .frame(width: 24, height: 24)
                                .contentShape(Rectangle())
                        }
                        .menuStyle(.borderlessButton)
                        .menuIndicator(.hidden)
                        .fixedSize()
                        .opacity(isHovered ? 1 : 0)
                        .animation(VAnimation.fast, value: isHovered)
                    } else {
                        Color.clear
                    }
                }
                .frame(width: 24)
            }
            .contentShape(Rectangle())
            .onHover { hovering in
                isHovered = hovering
            }
        }
    }

    private func channelDisplayName(_ key: String?) -> String {
        switch key {
        case "telegram": return "Telegram"
        case "slack": return "Slack"
        case "phone": return "Phone Calling"
        default: return key ?? ""
        }
    }

    private func performDisconnect(channel: String) {
        switch channel {
        case "telegram":
            store.clearTelegramCredentials()
            telegramBotTokenText = ""
            telegramSetupExpanded = false
            store.channelSetupStatus["telegram"] = "not_configured"
        case "slack":
            store.clearSlackChannelConfig()
            slackChannelBotTokenInput = ""
            slackChannelAppTokenInput = ""
            slackChannelSetupExpanded = false
            store.channelSetupStatus["slack"] = "not_configured"
        case "phone":
            store.clearTwilioCredentials()
            store.channelSetupStatus["phone"] = "not_configured"
        default:
            break
        }
    }

    // MARK: - Email Channel Card

    private var emailCard: some View {
        SettingsCard(title: "Email", subtitle: "Send and receive emails as your assistant", showBorder: showCardBorders) {
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
                VInlineMessage(
                    "Not configured — run the Email Setup skill to assign an address",
                    tone: .warning
                )
            }
        }
    }

    // MARK: - Telegram Channel Card

    private var telegramCard: some View {
        let status = store.channelSetupStatus["telegram"]
        return SettingsCard(title: "Telegram", subtitle: "Message your assistant from Telegram", showBorder: showCardBorders) {
            if status == "ready" {
                VBadge(label: "Connected", tone: .positive)
            }
        } content: {
            if status == "ready" {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    if let username = store.telegramBotUsername, !username.isEmpty {
                        if let url = URL(string: "https://t.me/\(username)") {
                            Link("@\(username)", destination: url)
                                .font(VFont.body)
                                .lineLimit(1)
                                .pointerCursor()
                        } else {
                            Text("@\(username)")
                                .font(VFont.body)
                                .foregroundColor(VColor.contentDefault)
                                .lineLimit(1)
                        }
                    }
                    if let botId = store.telegramBotId, !botId.isEmpty {
                        HStack(spacing: 0) {
                            Text("Bot ID: ")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                            Text(botId)
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                                .lineLimit(1)
                        }
                    }
                    VButton(label: "Disconnect", style: .dangerGhost, isDisabled: store.telegramSaveInProgress) {
                        store.clearTelegramCredentials()
                        telegramBotTokenText = ""
                        telegramSetupExpanded = false
                        store.channelSetupStatus["telegram"] = "not_configured"
                    }
                }
            } else if (status == "incomplete" && store.telegramHasBotToken) || telegramSetupExpanded {
                telegramCredentialEntry
            } else {
                VButton(label: "Set Up", style: .outlined) {
                    telegramSetupExpanded = true
                }
            }

            if let error = store.telegramError {
                VInlineMessage(error)
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
                    VButton(label: "Connect", style: .primary, isDisabled: telegramBotTokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                        store.saveTelegramToken(botToken: telegramBotTokenText)
                        telegramBotTokenText = ""
                    }
                    VButton(label: "Cancel", style: .ghost) {
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
        return SettingsCard(title: "Slack", subtitle: "Message your assistant from Slack", showBorder: showCardBorders) {
            if status == "ready" {
                VBadge(label: "Connected", tone: .positive)
            }
        } content: {
            if status == "ready" {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    if let username = store.slackChannelBotUsername, !username.isEmpty {
                        Text("@\(username)")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                            .lineLimit(1)
                    }
                    if let botUserId = store.slackChannelBotUserId, !botUserId.isEmpty {
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
                    VButton(label: "Disconnect", style: .dangerGhost, isDisabled: store.slackChannelSaveInProgress) {
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
                VInlineMessage(error)
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
                        style: .primary,
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
                    VButton(label: "Cancel", style: .ghost) {
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
        return SettingsCard(title: "Phone Calling", subtitle: "Receive and make phone calls via Twilio", showBorder: showCardBorders) {
            if status == "ready" {
                VBadge(label: "Connected", tone: .positive)
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
                VButton(label: "Disconnect", style: .dangerGhost, isDisabled: store.twilioSaveInProgress) {
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
                VInlineMessage(warning, tone: .warning)
            }

            if let error = store.twilioError {
                VInlineMessage(error)
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
                        style: .primary,
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
                    VButton(label: "Cancel", style: .ghost) {
                        voiceSetupExpanded = false
                        voiceAccountSidText = ""
                        voiceAuthTokenText = ""
                    }
                }
            }
        }
    }

}
