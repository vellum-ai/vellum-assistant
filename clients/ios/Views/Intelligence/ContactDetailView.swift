#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct ContactDetailView: View {
    let contact: ContactPayload
    @ObservedObject var contactsStore: ContactsStore
    @Environment(\.dismiss) private var dismiss
    @State private var showDeleteConfirmation = false
    @State private var channelForPolicyEdit: ContactChannelPayload?
    @State private var showPolicySheet = false

    /// Live contact data from store (updates when channel policy changes).
    private var liveContact: ContactPayload {
        contactsStore.contacts.first { $0.id == contact.id } ?? contact
    }

    var body: some View {
        List {
            // Info section
            Section {
                infoSection
            }

            // Details section
            Section("Details") {
                detailRow(label: "Role", value: liveContact.role.capitalized)

                if let contactType = liveContact.contactType, !contactType.isEmpty {
                    detailRow(label: "Type", value: contactType.capitalized)
                }

                detailRow(label: "Interactions", value: "\(liveContact.interactionCount)")

                if let lastInteraction = liveContact.lastInteraction, lastInteraction > 0 {
                    detailRow(label: "Last Interaction", value: formatTimestamp(lastInteraction))
                }
            }

            // Notes section
            if let notes = liveContact.notes, !notes.isEmpty {
                Section("Notes") {
                    Text(notes)
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }
            }

            // Channels section
            if !liveContact.channels.isEmpty {
                Section("Channels") {
                    ForEach(liveContact.channels) { channel in
                        channelRow(channel)
                    }
                }
            }

            // Danger zone
            Section {
                Button(role: .destructive) {
                    showDeleteConfirmation = true
                } label: {
                    HStack {
                        VIconView(.trash, size: 16)
                        Text("Delete Contact")
                    }
                }
            }
        }
        .navigationTitle(liveContact.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            contactsStore.getContact(id: contact.id)
        }
        .alert("Delete Contact", isPresented: $showDeleteConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) {
                contactsStore.deleteContact(id: contact.id)
                dismiss()
            }
        } message: {
            Text("Are you sure you want to delete \"\(liveContact.displayName)\"? This action cannot be undone.")
        }
        .confirmationDialog("Channel Policy", isPresented: $showPolicySheet, titleVisibility: .visible) {
            if let channel = channelForPolicyEdit {
                Button("Allow") {
                    contactsStore.updateContactChannel(channelId: channel.id, policy: "allow")
                }
                Button("Ask") {
                    contactsStore.updateContactChannel(channelId: channel.id, policy: "ask")
                }
                Button("Block") {
                    contactsStore.updateContactChannel(channelId: channel.id, policy: "block")
                }
                Button("Cancel", role: .cancel) {}
            }
        } message: {
            if let channel = channelForPolicyEdit {
                Text("Set the inbound message policy for \(channel.address)")
            }
        }
    }

    // MARK: - Info Section

    private var infoSection: some View {
        VStack(spacing: VSpacing.sm) {
            // Initials
            initialsView(for: liveContact.displayName, size: 64)

            Text(liveContact.displayName)
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            HStack(spacing: VSpacing.sm) {
                roleBadge(liveContact.role)

                if let contactType = liveContact.contactType, !contactType.isEmpty {
                    Text(contactType.capitalized)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Channel Row

    private func channelRow(_ channel: ContactChannelPayload) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack {
                channelTypeIcon(channel.type)

                VStack(alignment: .leading, spacing: 2) {
                    Text(channel.address)
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)

                    HStack(spacing: 4) {
                        Text(channel.type.capitalized)
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)

                        if channel.isPrimary {
                            Text("Primary")
                                .font(.caption2)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 1)
                                .background(Capsule().fill(Color.blue.opacity(0.15)))
                                .foregroundColor(.blue)
                        }
                    }
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 2) {
                    statusBadge(channel.status)
                    policyBadge(channel.policy)
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            channelForPolicyEdit = channel
            showPolicySheet = true
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Channel: \(channel.type), \(channel.address), status: \(channel.status), policy: \(channel.policy)\(channel.isPrimary ? ", primary" : "")")
        .accessibilityHint("Double-tap to change channel policy")
    }

    // MARK: - Badges

    private func statusBadge(_ status: String) -> some View {
        let color: Color = {
            switch status {
            case "verified": return .green
            case "pending": return .orange
            case "revoked": return .red
            case "blocked": return .red
            default: return .secondary
            }
        }()

        return Text(status.capitalized)
            .font(.caption2)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.15)))
            .foregroundColor(color)
    }

    private func policyBadge(_ policy: String) -> some View {
        let color: Color = {
            switch policy {
            case "allow": return .green
            case "ask": return .orange
            case "block": return .red
            default: return .secondary
            }
        }()

        return Text(policy.capitalized)
            .font(.caption2)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.15)))
            .foregroundColor(color)
    }

    private func roleBadge(_ role: String) -> some View {
        let color: Color = {
            switch role {
            case "guardian": return .blue
            case "admin": return .purple
            default: return .secondary
            }
        }()

        return Text(role.capitalized)
            .font(.caption2)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.15)))
            .foregroundColor(color)
    }

    // MARK: - Helpers

    private func channelTypeIcon(_ type: String) -> some View {
        let icon: VIcon = {
            switch type {
            case "email": return .mail
            case "sms", "phone": return .phone
            case "slack": return .hash
            case "discord": return .messageCircle
            case "telegram": return .send
            default: return .link
            }
        }()

        return VIconView(icon, size: 16)
            .foregroundColor(VColor.accent)
            .frame(width: 28)
    }

    private func initialsView(for name: String, size: CGFloat) -> some View {
        let initials = name.split(separator: " ")
            .prefix(2)
            .compactMap { $0.first.map(String.init) }
            .joined()
            .uppercased()

        return Text(initials.isEmpty ? "?" : initials)
            .font(.system(size: size * 0.35, weight: .semibold))
            .foregroundColor(.white)
            .frame(width: size, height: size)
            .background(Circle().fill(VColor.accent))
            .accessibilityHidden(true)
    }

    private func detailRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
            Spacer()
            Text(value)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }

    private func formatTimestamp(_ epoch: Double) -> String {
        let date = Date(timeIntervalSince1970: epoch / 1000.0)
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}
#endif
