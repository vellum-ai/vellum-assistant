#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Settings section for viewing guardian status and approved contact channel policies.
struct ChannelsGuardianSection: View {
    var channelTrustStore: ChannelTrustStore
    var contactsStore: ContactsStore
    @State private var showRevokeConfirmation = false
    @State private var channelToRevoke: ContactChannelPayload?

    var body: some View {
        Form {
            // MARK: - Guardian

            Section {
                if let guardian = channelTrustStore.guardianContact {
                    guardianRow(guardian)
                } else {
                    Text("No guardian configured")
                        .foregroundStyle(.secondary)
                        .font(.caption)
                }
            } header: {
                Text("Guardian")
            } footer: {
                Text("The guardian contact can approve or deny sensitive assistant actions on your behalf.")
            }

            // MARK: - Guardian Channels

            if !channelTrustStore.guardianChannels.isEmpty {
                Section("Guardian Channels") {
                    ForEach(channelTrustStore.guardianChannels) { channel in
                        guardianChannelRow(channel)
                    }
                }
            }

            // MARK: - Approved Contacts

            Section("Approved Contacts") {
                if contactsStore.otherContacts.isEmpty {
                    Text("No approved contacts")
                        .foregroundStyle(.secondary)
                        .font(.caption)
                } else {
                    ForEach(contactsStore.otherContacts) { contact in
                        contactRow(contact)
                    }
                }
            }
        }
        .navigationTitle("Channels & Guardian")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            contactsStore.loadContacts()
        }
        .alert("Revoke Channel", isPresented: $showRevokeConfirmation, presenting: channelToRevoke) { channel in
            Button("Revoke", role: .destructive) {
                channelTrustStore.revokeGuardian(channelId: channel.id)
                channelToRevoke = nil
            }
            Button("Cancel", role: .cancel) {
                channelToRevoke = nil
            }
        } message: { channel in
            Text("Revoke guardian access for \(channel.address)? This cannot be undone.")
        }
    }

    // MARK: - Guardian Row

    @ViewBuilder
    private func guardianRow(_ guardian: ContactPayload) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                VIconView(.shieldCheck, size: 14)
                    .foregroundStyle(VColor.systemPositiveStrong)
                Text(guardian.displayName)
                    .font(.body)
            }
            if let firstChannel = guardian.channels.first {
                Text("\(guardian.channels.count) channel\(guardian.channels.count == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if let verifiedAt = firstChannel.verifiedAt {
                    Text("Verified \(DateFormatting.relativeTimestamp(fromMilliseconds: verifiedAt) ?? "unknown")")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Guardian: \(guardian.displayName), \(guardian.channels.count) channel\(guardian.channels.count == 1 ? "" : "s")")
    }

    // MARK: - Guardian Channel Row

    @ViewBuilder
    private func guardianChannelRow(_ channel: ContactChannelPayload) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(channel.address)
                    .font(.body)
                HStack(spacing: 6) {
                    policyBadge(channel.policy)
                    statusBadge(channel.status)
                }
            }
            Spacer()
            Button {
                channelToRevoke = channel
                showRevokeConfirmation = true
            } label: {
                VIconView(.circleX, size: 14)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Revoke channel \(channel.address)")
            .accessibilityHint("Revokes guardian access for this channel")
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Guardian channel: \(channel.address), policy: \(channel.policy), status: \(channel.status)")
    }

    // MARK: - Contact Row

    @ViewBuilder
    private func contactRow(_ contact: ContactPayload) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(contact.displayName)
                .font(.body)
            if !contact.channels.isEmpty {
                HStack(spacing: 6) {
                    ForEach(contact.channels) { channel in
                        policyBadge(channel.policy)
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Contact: \(contact.displayName)\(!contact.channels.isEmpty ? ", \(contact.channels.count) channel\(contact.channels.count == 1 ? "" : "s")" : "")")
    }

    // MARK: - Badges

    @ViewBuilder
    private func policyBadge(_ policy: String) -> some View {
        let (color, label): (Color, String) = {
            switch policy {
            case "allow": return (VColor.systemPositiveStrong, "Allow")
            case "deny": return (VColor.systemNegativeStrong, "Deny")
            case "escalate": return (VColor.systemMidStrong, "Escalate")
            default: return (VColor.contentTertiary, policy.capitalized)
            }
        }()
        Text(label)
            .font(.caption2)
            .fontWeight(.medium)
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15))
            .clipShape(Capsule())
    }

    @ViewBuilder
    private func statusBadge(_ status: String) -> some View {
        let (color, label): (Color, String) = {
            switch status {
            case "active": return (VColor.systemPositiveStrong, "Active")
            case "revoked": return (VColor.systemNegativeStrong, "Revoked")
            case "pending": return (VColor.systemMidStrong, "Pending")
            default: return (VColor.contentTertiary, status.capitalized)
            }
        }()
        Text(label)
            .font(.caption2)
            .fontWeight(.medium)
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15))
            .clipShape(Capsule())
    }
}
#endif
