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
    @State private var channelReadiness: [String: DaemonClient.ChannelReadinessInfo] = [:]
    @State private var verificationDestinationTexts: [String: String] = [:]
    @State private var verificationCountdownNow: Date = Date()
    @State private var verificationCountdownTimer: Timer?
    @State private var setupExpanded: Set<String> = []
    @State private var verificationStoreRevision: Int = 0

    var displayContact: ContactPayload {
        currentContact ?? contact
    }

    var body: some View {
        let _ = verificationStoreRevision

        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                // Header
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Your Channels")
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

                if visibleTypes.isEmpty {
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
            currentContact = contact
            startVerificationCountdownTimer()
            for channel in Self.verificationSupportedChannels {
                store?.refreshChannelVerificationStatus(channel: channel)
            }
        }
        .onDisappear {
            stopVerificationCountdownTimer()
        }
        .task {
            channelReadiness = (try? await daemonClient?.fetchChannelReadiness()) ?? [:]
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

            // Prefer the latest verified channel to avoid showing stale status when
            // multiple non-revoked rows exist for the same channel type.
            let activeChannel = existingChannels.first(where: { $0.status == "active" && $0.verifiedAt != nil })
                ?? existingChannels.first

            if let channel = activeChannel, channel.status == "active", channel.verifiedAt != nil {
                // Verified channel — show address, badge, date + revoke action
                verifiedChannelContent(channel: channel, type: type)
            } else if !existingChannels.isEmpty || setupExpanded.contains(type) {
                // Existing unverified channel or user clicked "Set Up" — show verification flow
                verificationFlowContent(for: type)
            } else {
                // Channel ready on assistant but not yet started — show "Set Up"
                VButton(label: "Set Up", style: .outlined) {
                    setupExpanded.insert(type)
                }
            }

        }
    }

    // MARK: - Verified Channel Content

    @ViewBuilder
    private func verifiedChannelContent(channel: ContactChannelPayload, type: String) -> some View {
        // Show the channel address, verified badge, and date from the channel payload,
        // then delegate to ChannelVerificationFlowView for revoke/re-verify actions.
        // The channel payload is the source of truth for verified state — it is always
        // populated, even if the store hasn't refreshed yet (startup/offline).
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: VSpacing.sm) {
                        Text(channel.address)
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                            .lineLimit(1)

                        Text("Verified")
                            .font(VFont.captionMedium)
                            .foregroundColor(VColor.systemPositiveStrong)
                            .padding(.horizontal, VSpacing.sm)
                            .padding(.vertical, VSpacing.xxs)
                            .background(VColor.systemPositiveWeak)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
                    }

                    if let verifiedAt = channel.verifiedAt, verifiedAt > 0 {
                        let dateStr = formatDate(epochMs: verifiedAt)
                        let via = channel.verifiedVia ?? "unknown"
                        Text("Verified via \(via) on \(dateStr)")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                    }
                }

                Spacer()
            }

            // Use store state for the revoke/re-verify action flow, falling back to
            // a verified state derived from the channel payload when the store hasn't
            // loaded yet (startup, offline, or stale refresh).
            if let store {
                let storeState = store.channelVerificationState(for: type)
                let effectiveState = storeState.verified ? storeState : ChannelVerificationState(
                    channel: type,
                    identity: channel.address,
                    username: nil,
                    displayName: nil,
                    verified: true,
                    inProgress: false,
                    instruction: nil,
                    error: nil,
                    alreadyBound: false,
                    outboundSessionId: nil,
                    outboundExpiresAt: nil,
                    outboundNextResendAt: nil,
                    outboundSendCount: 0,
                    outboundCode: nil,
                    bootstrapUrl: nil
                )
                let destinationBinding = Binding<String>(
                    get: { verificationDestinationTexts[type] ?? "" },
                    set: { verificationDestinationTexts[type] = $0 }
                )
                ChannelVerificationFlowView(
                    state: effectiveState,
                    countdownNow: $verificationCountdownNow,
                    destinationText: destinationBinding,
                    onStartOutbound: { dest in store.startOutboundVerification(channel: type, destination: dest) },
                    onResend: { store.resendOutboundVerification(channel: type) },
                    onCancelOutbound: { store.cancelOutboundVerification(channel: type) },
                    onRevoke: { store.revokeChannelVerification(channel: type) },
                    onStartSession: { rebind in store.startChannelVerification(channel: type, rebind: rebind) },
                    onCancelSession: { store.cancelVerificationSession(channel: type) },
                    botUsername: store.telegramBotUsername,
                    phoneNumber: store.twilioPhoneNumber,
                    showLabel: false
                )
            }
        }
    }

    private func formatDate(epochMs: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(epochMs) / 1000)
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: date)
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
                onCancel: { setupExpanded.remove(type) },
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
