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
            Task {
                channelReadiness = (try? await daemonClient?.fetchChannelReadiness()) ?? [:]
            }
        }
        .onDisappear {
            stopVerificationCountdownTimer()
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

            if let channel = existingChannels.first, channel.status == "active", channel.verifiedAt != nil {
                // Verified channel — delegate to ChannelVerificationFlowView
                verifiedChannelContent(channel: channel, type: type)
            } else if !existingChannels.isEmpty || channelReadiness[type]?.ready == true {
                // Unverified/pending channel or no channel but assistant has this channel ready
                verificationFlowContent(for: type)
            }

        }
    }

    // MARK: - Verified Channel Content

    @ViewBuilder
    private func verifiedChannelContent(channel: ContactChannelPayload, type: String) -> some View {
        // ChannelVerificationFlowView already renders the full verified state
        // (identity text + "Revoke" button), so we delegate entirely to it.
        if let store {
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
                botUsername: store.telegramBotUsername,
                phoneNumber: store.twilioPhoneNumber,
                showLabel: false
            )
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
