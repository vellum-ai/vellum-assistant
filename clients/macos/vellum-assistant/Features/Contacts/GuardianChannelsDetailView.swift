import Combine
import SwiftUI
import VellumAssistantShared

/// Right-pane detail view that shows the guardian's channel verification cards
/// (Telegram, Phone, Slack) when the guardian row is selected in the Contacts list.
/// Mirrors the card-per-channel layout of AssistantChannelsDetailView.
@MainActor
struct GuardianChannelsDetailView: View {
    private static let allChannelTypes = ["telegram", "phone", "slack"]
    private static let verificationSupportedChannels: Set<String> = ["telegram", "phone", "slack"]

    let contact: ContactPayload
    var daemonClient: DaemonClient?
    var store: SettingsStore?
    var onSelectAssistant: (() -> Void)?

    @State var currentContact: ContactPayload?
    @State private var isLoadingReadiness: Bool = true
    @State private var channelReadiness: [String: DaemonClient.ChannelReadinessInfo] = [:]
    @State private var verificationDestinationTexts: [String: String] = [:]
    @State private var verificationCountdownNow: Date = Date()
    @State private var verificationCountdownTimer: Timer?
    @State private var setupExpanded: Set<String> = []
    @State private var dismissedChannels: Set<String> = []
    @State private var verificationStoreRevision: Int = 0
    @State private var actionInProgress: String? = nil
    @State private var errorMessage: String? = nil

    var displayContact: ContactPayload {
        currentContact ?? contact
    }

    var body: some View {
        let _ = verificationStoreRevision

        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                // Header
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Channels")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.contentDefault)
                    Text("Once verified, your assistant will recognize you when you message from these channels.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }

                // One card per channel type (only show configured or existing)
                let visibleTypes = Self.allChannelTypes.filter { type in
                    let hasExisting = displayContact.channels.contains { $0.type == type && $0.status != "revoked" }
                    return hasExisting || channelReadiness[type]?.ready == true
                }

                if isLoadingReadiness && visibleTypes.isEmpty {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, VSpacing.xl)
                } else if visibleTypes.isEmpty {
                    VStack(spacing: VSpacing.md) {
                        VIconView(.messageCircle, size: 24)
                            .foregroundColor(VColor.contentTertiary)
                        Text("No Channels Available")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentSecondary)
                        Text("Set up channels on your assistant first to verify your identity.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                            .multilineTextAlignment(.center)
                        VButton(label: "Set Up Assistant", style: .outlined) {
                            onSelectAssistant?()
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, VSpacing.xl)
                } else {
                    ForEach(visibleTypes, id: \.self) { type in
                        channelCard(for: type)
                    }
                }
            }
            .padding(VSpacing.lg)
        }
        .onAppear {
            startVerificationCountdownTimer()
            for channel in Self.verificationSupportedChannels {
                store?.refreshChannelVerificationStatus(channel: channel)
            }
        }
        .onChange(of: contact) { _, _ in
            currentContact = nil
        }
        .onDisappear {
            stopVerificationCountdownTimer()
        }
        .task {
            channelReadiness = (try? await daemonClient?.fetchChannelReadiness()) ?? [:]
            isLoadingReadiness = false
        }
        .onReceive(store?.objectWillChange.map { _ in () }.eraseToAnyPublisher() ?? Empty().eraseToAnyPublisher()) { _ in
            verificationStoreRevision += 1
        }
    }

    // MARK: - Channel Card

    @ViewBuilder
    private func channelCard(for type: String) -> some View {
        SettingsCard(title: channelLabel(for: type), subtitle: channelSubtitle(for: type)) {
            let existingChannels = displayContact.channels.filter { $0.type == type && $0.status != "revoked" }
            let activeChannel = existingChannels.first(where: { $0.status == "active" && $0.verifiedAt != nil })
                ?? existingChannels.first
            if let channel = activeChannel, channel.status == "active", channel.verifiedAt != nil {
                VBadge(style: .label("Verified"), color: VColor.systemPositiveStrong)
            } else if store?.channelVerificationState(for: type).verified == true {
                VBadge(style: .label("Verified"), color: VColor.systemPositiveStrong)
            }
        } content: {
            let existingChannels = displayContact.channels.filter { $0.type == type && $0.status != "revoked" }

            // Prefer the latest verified channel to avoid showing stale status when
            // multiple non-revoked rows exist for the same channel type.
            let activeChannel = existingChannels.first(where: { $0.status == "active" && $0.verifiedAt != nil })
                ?? existingChannels.first

            if let channel = activeChannel, channel.status == "active", channel.verifiedAt != nil {
                // Verified channel — show rich identity + disconnect
                verifiedChannelContent(channel: channel, type: type)
            } else if store?.channelVerificationState(for: type).verified == true
                || (!existingChannels.isEmpty && !dismissedChannels.contains(type))
                || setupExpanded.contains(type) {
                // Existing unverified channel or user clicked "Set Up" — show verification flow
                verificationFlowContent(for: type)
            } else {
                // Channel ready on assistant but not yet started — show "Set Up"
                VButton(label: "Set Up", style: .outlined) {
                    dismissedChannels.remove(type)
                    setupExpanded.insert(type)
                }
            }
        }
    }

    // MARK: - Verified Channel Content

    @ViewBuilder
    private func verifiedChannelContent(channel: ContactChannelPayload, type: String) -> some View {
        let verificationState = store?.channelVerificationState(for: type)

        VStack(alignment: .leading, spacing: VSpacing.sm) {
            if type == "telegram" {
                telegramVerifiedIdentity(channel: channel, verificationState: verificationState)
            } else if type == "slack" {
                slackVerifiedIdentity(channel: channel, verificationState: verificationState)
            } else if type == "phone" {
                Text(channel.address)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(1)
            } else {
                Text(channel.address)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(1)
            }

            if daemonClient != nil {
                VButton(label: "Disconnect", style: .danger, isDisabled: actionInProgress != nil) {
                    disconnectChannel(channelId: channel.id)
                }
            }
        }
    }

    // MARK: - Telegram Verified Identity

    /// Telegram-specific verified identity layout matching ChannelVerificationFlowView:
    /// 1. Display name (or username/identity as fallback)
    /// 2. @username (plain text, if available and not already shown)
    /// 3. "Telegram ID: " prefix + hyperlinked ID
    @ViewBuilder
    private func telegramVerifiedIdentity(channel: ContactChannelPayload, verificationState: ChannelVerificationState?) -> some View {
        let displayName = verificationState?.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let username = verificationState?.username?.trimmingCharacters(in: .whitespacesAndNewlines)
        let identity = (verificationState?.identity ?? channel.externalUserId)?.trimmingCharacters(in: .whitespacesAndNewlines)

        let formattedUsername: String? = {
            guard let username, !username.isEmpty else { return nil }
            return username.hasPrefix("@") ? username : "@\(username)"
        }()

        // Primary line: display name, else username, else identity, else address
        let nameLine = (displayName.flatMap { $0.isEmpty ? nil : $0 })
            ?? formattedUsername
            ?? identity
            ?? channel.address

        VStack(alignment: .leading, spacing: 2) {
            Text(nameLine)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
                .lineLimit(1)

            // Show @username if it wasn't already used as the name line
            if let formattedUsername, formattedUsername != nameLine {
                Text(formattedUsername)
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                    .lineLimit(1)
            }

            // Telegram ID line: only hyperlink the ID itself
            if let identity, !identity.isEmpty, identity != nameLine {
                HStack(spacing: 0) {
                    Text("Telegram ID: ")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                    if let url = URL(string: "https://web.telegram.org/a/#\(identity)") {
                        Link(identity, destination: url)
                            .font(VFont.caption)
                            .lineLimit(1)
                            .pointerCursor()
                    } else {
                        Text(identity)
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                            .lineLimit(1)
                    }
                }
            }
        }
    }

    // MARK: - Slack Verified Identity

    @ViewBuilder
    private func slackVerifiedIdentity(channel: ContactChannelPayload, verificationState: ChannelVerificationState?) -> some View {
        let displayName = verificationState?.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let username = verificationState?.username?.trimmingCharacters(in: .whitespacesAndNewlines)
        let identity = (verificationState?.identity ?? channel.externalUserId)?.trimmingCharacters(in: .whitespacesAndNewlines)

        let formattedUsername: String? = {
            guard let username, !username.isEmpty else { return nil }
            return username.hasPrefix("@") ? username : "@\(username)"
        }()

        // Primary line: display name or @username
        let primaryLine = (displayName.flatMap { $0.isEmpty ? nil : $0 })
            ?? formattedUsername
            ?? channel.address

        VStack(alignment: .leading, spacing: 2) {
            Text(primaryLine)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
                .lineLimit(1)

            // Secondary line: user ID
            if let identity, !identity.isEmpty {
                HStack(spacing: 0) {
                    Text("Slack ID: ")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                    if let teamId = store?.slackChannelTeamId,
                       let url = URL(string: "slack://user?team=\(teamId)&id=\(identity)") {
                        Link(identity, destination: url)
                            .font(VFont.caption)
                            .lineLimit(1)
                            .pointerCursor()
                    } else {
                        Text(identity)
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                            .lineLimit(1)
                    }
                }
            }
        }
    }

    // MARK: - Disconnect Channel

    private func disconnectChannel(channelId: String) {
        guard let daemonClient else { return }
        guard actionInProgress == nil else { return }
        actionInProgress = channelId
        errorMessage = nil

        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.sendUpdateContactChannel(channelId: channelId, status: "revoked")
            } catch {
                errorMessage = "Failed to update channel: \(error.localizedDescription)"
                actionInProgress = nil
                return
            }

            for await message in stream {
                if case .contactsResponse(let response) = message {
                    if response.success {
                        try? daemonClient.sendGetContact(contactId: displayContact.id)
                    } else {
                        errorMessage = response.error ?? "Failed to update channel"
                        actionInProgress = nil
                        return
                    }
                    break
                }
            }

            for await message in stream {
                if case .contactsResponse(let response) = message {
                    if let updatedContact = response.contact {
                        currentContact = updatedContact
                    }
                    actionInProgress = nil
                    return
                }
            }

            actionInProgress = nil
        }
    }

    // MARK: - Verification Flow Content

    @ViewBuilder
    private func verificationFlowContent(for type: String) -> some View {
        if Self.verificationSupportedChannels.contains(type), let store {
            let state = store.channelVerificationState(for: type)
            let destinationBinding = Binding<String>(
                get: { verificationDestinationTexts[type] ?? "" },
                set: { verificationDestinationTexts[type] = $0 }
            )
            ChannelVerificationFlowView(
                state: state,
                countdownNow: $verificationCountdownNow,
                destinationText: destinationBinding,
                onStartOutbound: { dest in store.startOutboundVerification(channel: type, destination: dest) },
                onResend: { store.resendOutboundVerification(channel: type) },
                onCancelOutbound: { store.cancelOutboundVerification(channel: type) },
                onRevoke: { store.revokeChannelVerification(channel: type) },
                onStartSession: { rebind in store.startChannelVerification(channel: type, rebind: rebind) },
                onCancelSession: { store.cancelVerificationSession(channel: type) },
                onCancel: {
                    setupExpanded.remove(type)
                    dismissedChannels.insert(type)
                },
                botUsername: store.telegramBotUsername,
                phoneNumber: store.twilioPhoneNumber,
                showLabel: false
            )
        }
    }

    // MARK: - Verification Countdown Timer

    private func startVerificationCountdownTimer() {
        guard verificationCountdownTimer == nil else { return }
        verificationCountdownNow = Date()
        verificationCountdownTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            Task { @MainActor in
                verificationCountdownNow = Date()
            }
        }
    }

    private func stopVerificationCountdownTimer() {
        verificationCountdownTimer?.invalidate()
        verificationCountdownTimer = nil
    }

    // MARK: - Helpers

    private func channelLabel(for type: String) -> String {
        switch type {
        case "telegram": return "Telegram"
        case "email": return "Email"
        case "whatsapp": return "WhatsApp"
        case "phone": return "Phone"
        case "slack": return "Slack"
        default: return type.capitalized
        }
    }

    private func channelSubtitle(for type: String) -> String {
        switch type {
        case "telegram": return "Message your assistant from Telegram"
        case "phone": return "Call or text your assistant via phone"
        case "slack": return "Message your assistant from Slack"
        default: return "Connect via \(type.capitalized)"
        }
    }

}
