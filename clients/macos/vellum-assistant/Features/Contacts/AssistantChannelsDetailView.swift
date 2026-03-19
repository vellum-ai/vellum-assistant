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
    var conversationManager: ConversationManager?
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

    // Collapsible row expanded states
    @State private var telegramRowExpanded: Bool = false
    @State private var slackRowExpanded: Bool = false
    @State private var voiceRowExpanded: Bool = false
    @State private var emailRowExpanded: Bool = false

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
                telegramRowExpanded = false
            }
        }
        .onChange(of: store.channelSetupStatus["slack"]) { _, status in
            if status == nil || status == "not_configured" {
                slackChannelSetupExpanded = false
                slackRowExpanded = false
            }
        }
        .onChange(of: store.channelSetupStatus["phone"]) { _, status in
            if status == nil || status == "not_configured" {
                voiceSetupExpanded = false
                voiceRowExpanded = false
            } else if status == "ready" {
                voiceSetupExpanded = false
                store.refreshTwilioNumbers()
            } else if status == "incomplete" {
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

    /// Settings tab layout: individual bordered cards per channel, own ScrollView.
    private var borderedLayout: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.xl) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Channels")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.contentDefault)
                    Text("Manage where \(assistantName) can be reached.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }

                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    slackChannelCard
                    telegramCard
                    voiceCard
                    if isEmailEnabled {
                        emailCard
                    }
                }
            }
            .padding(VSpacing.lg)
        }
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
        let isConnected = status == "ready"
        let value: String? = {
            if isConnected, let username = store.telegramBotUsername, !username.isEmpty {
                return "@\(username)"
            }
            return nil
        }()
        return Group {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                channelRowHeader(
                    name: "Telegram",
                    channelKey: "telegram",
                    value: value,
                    isConnected: isConnected,
                    isExpanded: $telegramRowExpanded,
                    setupAction: !isConnected && !telegramSetupExpanded && !(status == "incomplete" && store.telegramHasBotToken) ? {
                        conversationManager?.openConversation(
                            message: "I want to reach you on Telegram. Let's set it up.",
                            forceNew: true
                        )
                    } : nil,
                    isDisconnectDisabled: store.telegramSaveInProgress
                )
                if isConnected && telegramRowExpanded {
                    telegramCredentialEntry
                } else if !isConnected && (telegramSetupExpanded || (status == "incomplete" && store.telegramHasBotToken)) {
                    telegramCredentialEntry
                }
            }
            .padding(.vertical, VSpacing.sm)

            if let error = store.telegramError {
                VInlineMessage(error)
                    .padding(.bottom, VSpacing.sm)
            }
        }
    }

    private var slackRow: some View {
        let status = store.channelSetupStatus["slack"]
        let isConnected = status == "ready"
        let value: String? = {
            if isConnected, let username = store.slackChannelBotUsername, !username.isEmpty {
                return "@\(username)"
            }
            return nil
        }()
        return Group {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                channelRowHeader(
                    name: "Slack",
                    channelKey: "slack",
                    value: value,
                    isConnected: isConnected,
                    isExpanded: $slackRowExpanded,
                    setupAction: !isConnected && !slackChannelSetupExpanded && !(status == "incomplete" && (store.slackChannelHasBotToken || store.slackChannelHasAppToken)) ? {
                        conversationManager?.openConversation(
                            message: "I want to reach you on Slack. Let's set it up.",
                            forceNew: true
                        )
                    } : nil,
                    isDisconnectDisabled: store.slackChannelSaveInProgress
                )
                if isConnected && slackRowExpanded {
                    slackChannelCredentialEntry
                } else if !isConnected && (slackChannelSetupExpanded || (status == "incomplete" && (store.slackChannelHasBotToken || store.slackChannelHasAppToken))) {
                    slackChannelCredentialEntry
                }
            }
            .padding(.vertical, VSpacing.sm)

            if let error = store.slackChannelError {
                VInlineMessage(error)
                    .padding(.bottom, VSpacing.sm)
            }
        }
    }

    private var voiceRow: some View {
        let isConnected = store.twilioHasCredentials
        let value: String? = {
            if isConnected, let phone = store.twilioPhoneNumber {
                // Display friendlyName when available for proper formatting
                if let match = store.twilioNumbers.first(where: { $0.phoneNumber == phone }) {
                    return match.friendlyName
                }
                return phone
            }
            return nil
        }()
        return Group {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                channelRowHeader(
                    name: "Phone Calling",
                    channelKey: "phone",
                    value: value,
                    isConnected: isConnected,
                    isExpanded: $voiceRowExpanded,
                    setupAction: !isConnected && !voiceSetupExpanded ? {
                        conversationManager?.openConversation(
                            message: "I want to be able to call you. Let's set you up with a phone number.",
                            forceNew: true
                        )
                    } : nil,
                    isDisconnectDisabled: store.twilioSaveInProgress
                )
                if isConnected && voiceRowExpanded {
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
                            emptyValue: "",
                            maxWidth: 280
                        )
                    }
                } else if !isConnected && voiceSetupExpanded {
                    voiceCredentialEntry
                }
            }
            .padding(.vertical, VSpacing.sm)

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
        let isConnected = store.assistantEmail != nil
        let value: String? = store.assistantEmail ?? "Not configured"
        return Group {
            channelRowHeader(
                name: "Email",
                value: value,
                isConnected: isConnected,
                isExpanded: $emailRowExpanded
            )
            .padding(.vertical, VSpacing.sm)
        }
    }

    // MARK: - Channel Row Header (3-column layout)

    private func channelIcon(for name: String) -> VIcon {
        switch name {
        case "Slack": return .hash
        case "Telegram": return .send
        case "Phone Calling": return .phone
        case "Email": return .mail
        default: return .messageCircle
        }
    }

    private func channelRowHeader(
        name: String,
        channelKey: String? = nil,
        value: String?,
        isConnected: Bool,
        isExpanded: Binding<Bool>,
        setupAction: (() -> Void)? = nil,
        isDisconnectDisabled: Bool = false
    ) -> some View {
        ChannelRowHeader(
            name: name,
            icon: channelIcon(for: name),
            channelKey: channelKey,
            value: value,
            isConnected: isConnected,
            isExpanded: isExpanded,
            setupAction: setupAction,
            isDisconnectDisabled: isDisconnectDisabled,
            onDisconnect: { key in channelToDisconnect = key }
        )
    }

    /// A single channel row header with collapsible chevron and inline disconnect button.
    private struct ChannelRowHeader: View {
        let name: String
        var icon: VIcon = .messageCircle
        var channelKey: String?
        let value: String?
        let isConnected: Bool
        @Binding var isExpanded: Bool
        var isExpandable: Bool = true
        var setupAction: (() -> Void)?
        var isDisconnectDisabled: Bool = false
        var onDisconnect: ((String) -> Void)?

        var body: some View {
            HStack(spacing: VSpacing.sm) {
                // Left: chevron (when connected) + channel icon + name
                if isConnected {
                    VIconView(isExpanded ? .chevronUp : .chevronDown, size: 12)
                        .foregroundColor(isExpandable ? VColor.contentTertiary : VColor.contentDisabled)
                }
                VIconView(icon, size: 16)
                    .foregroundColor(VColor.contentSecondary)
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
                if isConnected {
                    VButton(label: "Connected", leftIcon: VIcon.circleCheck.rawValue, style: .primary) {}

                    // Inline disconnect X button
                    if let channelKey {
                        VButton(label: "Disconnect", style: .danger, isDisabled: isDisconnectDisabled) {
                            onDisconnect?(channelKey)
                        }
                    }
                } else if let setupAction {
                    VButton(label: "Set up", style: .outlined) {
                        setupAction()
                    }
                }
            }
            .frame(minHeight: 36)
            .contentShape(Rectangle())
            .onTapGesture {
                if isConnected && isExpandable {
                    withAnimation(VAnimation.fast) {
                        isExpanded.toggle()
                    }
                }
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
            telegramRowExpanded = false
            store.channelSetupStatus["telegram"] = "not_configured"
        case "slack":
            store.clearSlackChannelConfig()
            slackChannelBotTokenInput = ""
            slackChannelAppTokenInput = ""
            slackChannelSetupExpanded = false
            slackRowExpanded = false
            store.channelSetupStatus["slack"] = "not_configured"
        case "phone":
            store.clearTwilioCredentials()
            voiceRowExpanded = false
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
                VButton(label: "Connected", leftIcon: VIcon.circleCheck.rawValue, style: .primary) {}
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
                    conversationManager?.openConversation(
                        message: "I want to reach you on Telegram. Let's set it up.",
                        forceNew: true
                    )
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
            VTextField(
                "Bot Token",
                placeholder: "Telegram bot token",
                text: $telegramBotTokenText,
                isSecure: true,
                maxWidth: 400
            )

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
                        telegramRowExpanded = false
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
                VButton(label: "Connected", leftIcon: VIcon.circleCheck.rawValue, style: .primary) {}
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
                    conversationManager?.openConversation(
                        message: "I want to reach you on Slack. Let's set it up.",
                        forceNew: true
                    )
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
            VTextField(
                "Bot Token",
                placeholder: "Bot Token (xoxb-...)",
                text: $slackChannelBotTokenInput,
                isSecure: true,
                maxWidth: 400
            )

            VTextField(
                "App Token",
                placeholder: "App Token (xapp-...)",
                text: $slackChannelAppTokenInput,
                isSecure: true,
                maxWidth: 400
            )

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
                        slackRowExpanded = false
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
            if store.twilioHasCredentials {
                VButton(label: "Connected", leftIcon: VIcon.circleCheck.rawValue, style: .primary) {}
            }
        } content: {
            if status == "ready" {
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
                        emptyValue: "",
                        maxWidth: 400
                    )
                }

                VButton(label: "Disconnect", style: .dangerGhost, isDisabled: store.twilioSaveInProgress) {
                    store.clearTwilioCredentials()
                    store.channelSetupStatus["phone"] = "not_configured"
                }
            } else if (status == "incomplete" && store.twilioHasCredentials) || voiceSetupExpanded {
                voiceCredentialEntry
            } else {
                VButton(label: "Set Up", style: .outlined) {
                    conversationManager?.openConversation(
                        message: "I want to be able to call you. Let's set you up with a phone number.",
                        forceNew: true
                    )
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
            VTextField(
                "Account SID",
                placeholder: "Account SID",
                text: $voiceAccountSidText,
                maxWidth: 400
            )

            VTextField(
                "Auth Token",
                placeholder: "Auth Token",
                text: $voiceAuthTokenText,
                isSecure: true,
                maxWidth: 400
            )

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
                        voiceRowExpanded = false
                        voiceAccountSidText = ""
                        voiceAuthTokenText = ""
                    }
                }
            }
        }
    }

}
