import Combine
import SwiftUI
import VellumAssistantShared

/// Right-pane detail view that shows the guardian's channel verification cards
/// (Telegram, Phone, Slack) when the guardian row is selected in the Contacts list.
/// Mirrors the card-per-channel layout of AssistantChannelsDetailView.
@MainActor
struct GuardianChannelsDetailView: View {
    private static let allChannelTypes = ["slack", "telegram", "phone"]
    private static let verificationSupportedChannels: Set<String> = ["telegram", "phone", "slack"]

    let contact: ContactPayload
    var daemonClient: DaemonClient?
    var contactClient: ContactClientProtocol = ContactClient()
    var channelClient: ChannelClientProtocol = ChannelClient()
    var store: SettingsStore?
    var onSelectAssistant: (() -> Void)?
    var showCardBorders: Bool = true

    @State var currentContact: ContactPayload?
    @State private var isLoadingReadiness: Bool = true
    @State private var channelReadiness: [String: ChannelReadinessInfo] = [:]
    @State private var verificationDestinationTexts: [String: String] = [:]
    @State private var verificationCountdownNow: Date = Date()
    @State private var verificationCountdownTimer: Timer?
    @State private var setupExpanded: Set<String> = []
    @State private var dismissedChannels: Set<String> = []
    @State private var verificationStoreRevision: Int = 0
    @State private var actionInProgress: String? = nil
    @State private var errorMessage: String? = nil
    @State private var errorChannelType: String? = nil
    @State private var channelToRevoke: (id: String, type: String)? = nil

    var displayContact: ContactPayload {
        currentContact ?? contact
    }

    var body: some View {
        let _ = verificationStoreRevision

        Group {
            if showCardBorders {
                ScrollView { content }
            } else {
                content
            }
        }
        .confirmationDialog(
            "Revoke \(channelLabel(for: channelToRevoke?.type ?? "")) access?",
            isPresented: Binding(
                get: { channelToRevoke != nil },
                set: { if !$0 { channelToRevoke = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Revoke", role: .destructive) {
                if let revoke = channelToRevoke {
                    disconnectChannel(channelId: revoke.id, type: revoke.type)
                }
                channelToRevoke = nil
            }
            Button("Cancel", role: .cancel) {
                channelToRevoke = nil
            }
        } message: {
            Text("This will revoke the verified connection for this channel. The contact will need to re-verify to use this channel again.")
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
            channelReadiness = await channelClient.fetchChannelReadiness()
            isLoadingReadiness = false
        }
        .onReceive(store?.objectWillChange.map { _ in () }.eraseToAnyPublisher() ?? Empty().eraseToAnyPublisher()) { _ in
            verificationStoreRevision += 1
        }
    }

    private var visibleTypes: [String] {
        Self.allChannelTypes.filter { type in
            let hasExisting = displayContact.channels.contains { $0.type == type && $0.status != "revoked" }
            let readiness = channelReadiness[type]
            let isAvailable = readiness?.ready == true
                || readiness?.setupStatus == "ready"
                || readiness?.setupStatus == "incomplete"
            return hasExisting || isAvailable
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Channels")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.contentDefault)
                Text("Once verified, your assistant will recognize you when you message from these channels.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }

            if isLoadingReadiness && visibleTypes.isEmpty {
                channelSkeletonRows()
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
                    if let onSelectAssistant {
                        VButton(label: "Set Up Assistant", style: .outlined) {
                            onSelectAssistant()
                        }
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, VSpacing.xl)
            } else if showCardBorders {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    ForEach(visibleTypes, id: \.self) { type in
                        channelCard(for: type)
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(visibleTypes.enumerated()), id: \.element) { index, type in
                        channelCard(for: type)
                        if index < visibleTypes.count - 1 {
                            SettingsDivider()
                                .padding(.vertical, VSpacing.sm)
                        }
                    }
                }
            }
        }
        .padding(showCardBorders ? VSpacing.lg : 0)
    }

    // MARK: - Channel Card

    private func channelIcon(for type: String) -> VIcon {
        switch type {
        case "slack": return .hash
        case "telegram": return .send
        case "phone": return .phone
        default: return .messageCircle
        }
    }

    @ViewBuilder
    private func channelCard(for type: String) -> some View {
        let existingChannels = displayContact.channels.filter { $0.type == type && $0.status != "revoked" }
        let activeChannel = existingChannels.first(where: { $0.status == "active" && $0.verifiedAt != nil })
            ?? existingChannels.first
        let isVerified = (activeChannel?.status == "active" && activeChannel?.verifiedAt != nil)
            || store?.channelVerificationState(for: type).verified == true

        if showCardBorders {
            SettingsCard(title: channelLabel(for: type), subtitle: channelSubtitle(for: type), showBorder: true) {
                if isVerified {
                    VBadge(label: "Verified", tone: .positive)
                }
            } content: {
                channelCardContent(type: type, existingChannels: existingChannels, activeChannel: activeChannel, isVerified: isVerified)
            }
        } else {
            let needsSetup = !isVerified
                && store?.channelVerificationState(for: type).verified != true
                && (existingChannels.isEmpty || dismissedChannels.contains(type))
                && !setupExpanded.contains(type)

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                HStack(spacing: VSpacing.sm) {
                    VIconView(channelIcon(for: type), size: 16)
                        .foregroundColor(isVerified ? VColor.systemPositiveStrong : VColor.contentSecondary)
                    Text(channelLabel(for: type))
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.contentDefault)

                    if isVerified, let channel = activeChannel {
                        Text(channel.address)
                            .font(VFont.body)
                            .foregroundColor(VColor.contentSecondary)
                            .lineLimit(1)
                    }

                    Spacer()

                    if isVerified {
                        VButton(label: "Verified", leftIcon: VIcon.circleCheck.rawValue, style: .primary) {}
                        if let channel = activeChannel, daemonClient != nil {
                            VButton(label: "Revoke", style: .danger) {
                                channelToRevoke = (id: channel.id, type: type)
                            }
                        }
                    } else if needsSetup {
                        VButton(label: "Set up", style: .outlined) {
                            dismissedChannels.remove(type)
                            setupExpanded.insert(type)
                        }
                    }
                }
                .frame(minHeight: 36)

                if !needsSetup && !isVerified {
                    channelCardContent(type: type, existingChannels: existingChannels, activeChannel: activeChannel, isVerified: isVerified)
                }
            }
        }
    }

    @ViewBuilder
    private func channelCardContent(type: String, existingChannels: [ContactChannelPayload], activeChannel: ContactChannelPayload?, isVerified: Bool) -> some View {
        if let channel = activeChannel, isVerified {
            verifiedChannelContent(channel: channel, type: type)
        } else if store?.channelVerificationState(for: type).verified == true
            || (!existingChannels.isEmpty && !dismissedChannels.contains(type))
            || setupExpanded.contains(type) {
            verificationFlowContent(for: type)
        }

        if errorChannelType == type, let errorMessage {
            VInlineMessage(errorMessage)
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
                VButton(label: "Disconnect", style: .dangerGhost, isDisabled: actionInProgress != nil) {
                    disconnectChannel(channelId: channel.id, type: type)
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
                            .vPointerCursor()
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
                            .vPointerCursor()
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

    private func disconnectChannel(channelId: String, type: String) {
        guard actionInProgress == nil else { return }
        actionInProgress = channelId
        errorMessage = nil
        errorChannelType = nil

        Task {
            do {
                _ = try await contactClient.updateContactChannel(channelId: channelId, status: "revoked", policy: nil, reason: nil)
                let refreshed = try await contactClient.fetchContact(contactId: displayContact.id)
                if let refreshed {
                    currentContact = refreshed
                }
            } catch {
                errorMessage = "Failed to update channel: \(error.localizedDescription)"
                errorChannelType = type
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
                showLabel: false,
                autoFocus: true
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

    // MARK: - Skeleton Loading

    /// Skeleton placeholder rows matching the number of channels the assistant has set up.
    private func channelSkeletonRows() -> some View {
        let configuredCount = Self.allChannelTypes.filter { type in
            let status = store?.channelSetupStatus[type]
            return status == "ready"
        }.count
        let rowCount = max(configuredCount, 1)
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(0..<rowCount, id: \.self) { index in
                HStack(spacing: VSpacing.sm) {
                    VSkeletonBone(width: 16, height: 16, radius: VRadius.xs)
                    VSkeletonBone(width: 100, height: 14)
                    Spacer()
                    VSkeletonBone(width: 72, height: 28, radius: VRadius.md)
                }
                .frame(minHeight: 36)
                .padding(.vertical, VSpacing.sm)
                if index < rowCount - 1 {
                    SettingsDivider()
                }
            }
        }
        .accessibilityHidden(true)
    }

    // MARK: - Helpers

    private func channelLabel(for type: String) -> String {
        switch type {
        case "telegram": return "Telegram"
        case "email": return "Email"
        case "whatsapp": return "WhatsApp"
        case "phone": return "Phone Calling"
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
