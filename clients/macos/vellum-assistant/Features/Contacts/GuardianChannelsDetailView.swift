import Combine
import SwiftUI
import VellumAssistantShared

/// Right-pane detail view that shows the guardian's channel verification cards
/// (Telegram, Phone, Slack) when the guardian row is selected in the Contacts list.
/// Mirrors the card-per-channel layout of AssistantChannelsDetailView.
@MainActor
struct GuardianChannelsDetailView: View {
    /// Channels surfaced as cards, with their display metadata (label,
    /// subtitle, icon, verification capability, setup-message copy).
    /// Hydrated from the gateway's `channels/available` endpoint on first
    /// task; stays empty if the fetch fails.
    @State private var availableChannels: [ChannelInfo] = []

    let contact: ContactPayload
    var connectionManager: GatewayConnectionManager?
    var contactClient: ContactClientProtocol = ContactClient()
    var channelClient: ChannelClientProtocol = ChannelClient()
    var store: SettingsStore?
    var conversationManager: ConversationManager?
    var onSelectAssistant: (() -> Void)?
    var showCardBorders: Bool = true
    var setupButtonLabel: String = "Enable"

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
        }
        .onChange(of: contact) { _, _ in
            currentContact = nil
        }
        .onDisappear {
            stopVerificationCountdownTimer()
        }
        .task {
            channelReadiness = await channelClient.fetchChannelReadiness()
            // Hydrate availability + metadata from the gateway. On failure
            // (network, gateway pre-rollout) revert to the static default
            // so the UI never carries stale state from a prior success.
            availableChannels = await channelClient.fetchChannelAvailability() ?? []
            // Pre-warm verification status for every verification-capable
            // channel. Runs after availability hydrates so newly-surfaced
            // verification-capable channels are included automatically.
            for info in availableChannels where info.supportsVerification {
                store?.refreshChannelVerificationStatus(channel: info.id)
            }
            isLoadingReadiness = false
        }
        .onReceive(store?.objectWillChange.map { _ in () }.eraseToAnyPublisher() ?? Empty().eraseToAnyPublisher()) { _ in
            verificationStoreRevision += 1
        }
    }

    private var visibleTypes: [String] {
        // Show only channels the assistant has configured (ready/incomplete).
        return availableChannels.map(\.id).filter { type in
            let hasExisting = displayContact.channels.contains { $0.type == type && $0.status != "revoked" }
            guard !hasExisting else { return true }
            guard let info = channelReadiness[type] else { return false }
            return info.ready || info.setupStatus == "ready" || info.setupStatus == "incomplete"
        }
    }

    /// Channel content rows. The parent SettingsCard provides the "Channels" title/subtitle header.
    private var content: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            if isLoadingReadiness && visibleTypes.isEmpty {
                channelSkeletonRows()
            } else if visibleTypes.isEmpty {
                VStack(spacing: VSpacing.md) {
                    VIconView(.messageCircle, size: 24)
                        .foregroundStyle(VColor.contentTertiary)
                    Text("No Channels Available")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                    Text("Set up channels on your assistant first to verify your identity.")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
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

    /// Look up a channel's display metadata from the hydrated availability
    /// list. Returns `nil` for ids that aren't currently surfaced — the
    /// caller decides on a fallback.
    private func channelInfo(for type: String) -> ChannelInfo? {
        availableChannels.first(where: { $0.id == type })
    }

    private func channelIcon(for type: String) -> VIcon {
        guard let info = channelInfo(for: type) else { return .messageCircle }
        // Backend returns a bare lucide icon name (e.g. "mail"); VIcon
        // raw values carry the "lucide-" prefix.
        return VIcon(rawValue: "lucide-\(info.icon)") ?? .messageCircle
    }

    private func supportsVerification(for type: String) -> Bool {
        channelInfo(for: type)?.supportsVerification ?? false
    }

    @ViewBuilder
    private func channelCard(for type: String) -> some View {
        let existingChannels = displayContact.channels.filter { $0.type == type && $0.status != "revoked" }
        let activeChannel = existingChannels.first(where: { $0.status == "active" && $0.verifiedAt != nil })
            ?? existingChannels.first
        let isGuardian = displayContact.role == "guardian"
        let isVerified = (activeChannel?.status == "active" && activeChannel?.verifiedAt != nil)
            || (isGuardian && store?.channelVerificationState(for: type).verified == true)

        if showCardBorders {
            SettingsCard(title: channelLabel(for: type), subtitle: channelSubtitle(for: type), showBorder: true) {
                if isVerified {
                    VBadge(label: "Verified", tone: .positive)
                }
            } content: {
                channelCardContent(type: type, existingChannels: existingChannels, activeChannel: activeChannel, isVerified: isVerified, isGuardian: isGuardian)
            }
        } else {
            let storeVerified = isGuardian && (store?.channelVerificationState(for: type).verified == true)
            let needsSetup = !isVerified
                && !storeVerified
                && (existingChannels.isEmpty || dismissedChannels.contains(type))
                && !setupExpanded.contains(type)

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                HStack(spacing: VSpacing.sm) {
                    VIconView(channelIcon(for: type), size: 16)
                        .foregroundStyle(isVerified ? VColor.systemPositiveStrong : VColor.contentSecondary)
                    Text(channelLabel(for: type))
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)

                    if isVerified, let channel = activeChannel {
                        Text(channel.address)
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentSecondary)
                            .lineLimit(1)
                    }

                    Spacer()

                    if isVerified {
                        VButton(label: "Verified", leftIcon: VIcon.circleCheck.rawValue, style: .primary) {}
                        if let channel = activeChannel, connectionManager != nil {
                            VButton(label: "Revoke", style: .danger) {
                                channelToRevoke = (id: channel.id, type: type)
                            }
                        }
                    } else if needsSetup {
                        VButton(label: setupButtonLabel, style: .outlined) {
                            if let conversationManager {
                                conversationManager.openConversation(
                                    message: channelSetupMessage(for: type, isGuardian: isGuardian),
                                    forceNew: true
                                )
                            } else {
                                dismissedChannels.remove(type)
                                setupExpanded.insert(type)
                            }
                        }
                    } else if !isGuardian, let channel = existingChannels.first {
                        VButton(label: "Mark Verified", style: .outlined, isDisabled: actionInProgress != nil) {
                            verifyChannel(channelId: channel.id, type: type)
                        }
                    }
                }
                .frame(minHeight: 36)

                if !needsSetup && !isVerified {
                    channelCardContent(type: type, existingChannels: existingChannels, activeChannel: activeChannel, isVerified: isVerified, isGuardian: isGuardian)
                }
            }
        }
    }

    @ViewBuilder
    private func channelCardContent(type: String, existingChannels: [ContactChannelPayload], activeChannel: ContactChannelPayload?, isVerified: Bool, isGuardian: Bool = true) -> some View {
        if let channel = activeChannel, isVerified {
            verifiedChannelContent(channel: channel, type: type)
        } else if (isGuardian && store?.channelVerificationState(for: type).verified == true)
            || (!existingChannels.isEmpty && !dismissedChannels.contains(type))
            || setupExpanded.contains(type) {
            verificationFlowContent(for: type)
        } else {
            VButton(label: setupButtonLabel, style: .outlined) {
                if let conversationManager {
                    conversationManager.openConversation(
                        message: channelSetupMessage(for: type, isGuardian: isGuardian),
                        forceNew: true
                    )
                } else {
                    dismissedChannels.remove(type)
                    setupExpanded.insert(type)
                }
            }
        }

        if errorChannelType == type, let errorMessage {
            VNotification(errorMessage, tone: .negative)
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
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
            } else {
                Text(channel.address)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
            }

            if connectionManager != nil {
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
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)

            // Show @username if it wasn't already used as the name line
            if let formattedUsername, formattedUsername != nameLine {
                Text(formattedUsername)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .lineLimit(1)
            }

            // Telegram ID line: only hyperlink the ID itself
            if let identity, !identity.isEmpty, identity != nameLine {
                HStack(spacing: 0) {
                    Text("Telegram ID: ")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    if let url = URL(string: "https://web.telegram.org/a/#\(identity)") {
                        VLink(identity, destination: url)
                    } else {
                        Text(identity)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
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
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)

            // Secondary line: user ID
            if let identity, !identity.isEmpty {
                HStack(spacing: 0) {
                    Text("Slack ID: ")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    if let teamId = store?.slackChannelTeamId,
                       let url = URL(string: "slack://user?team=\(teamId)&id=\(identity)") {
                        VLink(identity, destination: url)
                    } else {
                        Text(identity)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                            .lineLimit(1)
                    }
                }
            }
        }
    }

    // MARK: - Channel Actions

    /// Runs an async channel action with shared loading/error/refresh handling.
    private func performChannelAction(channelId: String, type: String, errorLabel: String, action: @escaping () async throws -> Void) {
        guard actionInProgress == nil else { return }
        actionInProgress = channelId
        errorMessage = nil
        errorChannelType = nil

        Task {
            do {
                try await action()
                let refreshed = try await contactClient.fetchContact(contactId: displayContact.id)
                if let refreshed {
                    currentContact = refreshed
                }
            } catch {
                errorMessage = "Failed to \(errorLabel) channel: \(error.localizedDescription)"
                errorChannelType = type
            }
            actionInProgress = nil
        }
    }

    private func disconnectChannel(channelId: String, type: String) {
        performChannelAction(channelId: channelId, type: type, errorLabel: "update") {
            _ = try await contactClient.updateContactChannel(channelId: channelId, status: "revoked", policy: nil, reason: nil)
        }
    }

    private func verifyChannel(channelId: String, type: String) {
        performChannelAction(channelId: channelId, type: type, errorLabel: "verify") {
            _ = try await contactClient.verifyContactChannel(channelId: channelId)
        }
    }

    // MARK: - Verification Flow Content

    @ViewBuilder
    private func verificationFlowContent(for type: String) -> some View {
        if supportsVerification(for: type), let store {
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
        let configuredCount = availableChannels.filter { info in
            let status = store?.channelSetupStatus[info.id]
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
        channelInfo(for: type)?.label ?? type.capitalized
    }

    private func channelSetupMessage(for type: String, isGuardian: Bool) -> String {
        if let messages = channelInfo(for: type)?.setupMessages {
            return isGuardian ? messages.guardian : messages.contact
        }
        // Conservative fallback for an unknown id — should not happen
        // because we only render cards for ids returned by the gateway.
        if isGuardian {
            return "I'd like to verify my identity as your guardian on \(type.capitalized). Can you help me set that up?"
        }
        return "I'd like to verify a contact's \(type.capitalized) identity. Can you walk me through it?"
    }

    private func channelSubtitle(for type: String) -> String {
        channelInfo(for: type)?.subtitle ?? "Connect via \(type.capitalized)"
    }

}
