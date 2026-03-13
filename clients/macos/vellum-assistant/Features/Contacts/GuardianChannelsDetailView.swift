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

    @State var currentContact: ContactPayload?
    @State private var channelReadiness: [String: DaemonClient.ChannelReadinessInfo] = [:]
    @State private var verificationDestinationTexts: [String: String] = [:]
    @State private var verificationCountdownNow: Date = Date()
    @State private var verificationCountdownTimer: Timer?
    @State private var verificationStoreRevision: Int = 0
    @State private var errorMessage: String?

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

                // One card per channel type
                ForEach(Self.allChannelTypes, id: \.self) { type in
                    channelCard(for: type)
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
                // Verified channel — show verified badge row with revoke option
                verifiedChannelContent(channel: channel, type: type)
            } else if !existingChannels.isEmpty || channelReadiness[type]?.ready == true {
                // Unverified/pending channel or no channel but assistant has this channel ready
                verificationFlowContent(for: type)
            } else {
                // Channel not configured on the assistant
                HStack(spacing: VSpacing.sm) {
                    VIconView(.triangleAlert, size: 12)
                        .foregroundColor(VColor.systemNegativeHover)
                    Text("Set up this channel on your assistant first")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemNegativeStrong)
            }
        }
    }

    // MARK: - Verified Channel Content

    @ViewBuilder
    private func verifiedChannelContent(channel: ContactChannelPayload, type: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                VIconView(channelIcon(for: type), size: 14)
                    .foregroundColor(VColor.contentSecondary)
                    .frame(width: 20, alignment: .center)

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

            // Revoke via ChannelVerificationFlowView
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

    private func channelIcon(for type: String) -> VIcon {
        switch type {
        case "telegram":
            return .send
        case "phone":
            return .phoneCall
        case "email":
            return .mail
        case "whatsapp", "slack":
            return .messageCircle
        default:
            return .globe
        }
    }

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

    private func formatDate(epochMs: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(epochMs) / 1000)
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }
}
