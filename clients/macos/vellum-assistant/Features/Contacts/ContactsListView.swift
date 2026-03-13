import SwiftUI
import VellumAssistantShared

/// Displays the list of contacts, with an assistant section at the top,
/// a guardian ("Me") section, search, channel icons, and status indicators.
@MainActor
struct ContactsListView: View {
    @ObservedObject var viewModel: ContactsViewModel
    @Binding var selection: ContactSelection?
    var store: SettingsStore?

    @State private var hoveredContactId: String?
    @State private var isAssistantHovered = false
    @State private var cachedAssistantDisplayName: String = AssistantDisplayName.placeholder

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            if viewModel.isLoading && viewModel.contacts.isEmpty {
                loadingState
            } else if viewModel.contacts.isEmpty {
                emptyState
            } else {
                contactsList
            }
        }
        .onAppear {
            viewModel.loadContacts()
        }
        .task {
            cachedAssistantDisplayName = AssistantDisplayName.firstUserFacing(from: [IdentityInfo.load()?.name]) ?? AssistantDisplayName.placeholder
        }
        .onReceive(NotificationCenter.default.publisher(for: .identityChanged)) { _ in
            cachedAssistantDisplayName = AssistantDisplayName.firstUserFacing(from: [IdentityInfo.load()?.name]) ?? AssistantDisplayName.placeholder
        }
    }

    // MARK: - Search Bar

    private var searchBar: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.search, size: 12)
                .foregroundColor(VColor.contentTertiary)
            TextField("Search contacts...", text: $viewModel.searchQuery)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
        }
        .padding(VSpacing.sm)
        .background(VColor.surfaceActive)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    // MARK: - Contacts List

    private var contactsList: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Assistant section (always visible, unaffected by search)
            assistantSection

            // Guardian ("Me") section
            if let guardian = viewModel.guardianContact {
                guardianSection(guardian)
            }

            // Other contacts section (always show header + "+" button)
            otherContactsSection

            // Filtered-empty state (contacts exist but search yields nothing)
            if viewModel.filteredContacts.isEmpty && !viewModel.contacts.isEmpty {
                VStack(spacing: VSpacing.sm) {
                    Text("No matching contacts")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                    Text("Try a different search term")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, VSpacing.xl)
            }
        }
    }

    // MARK: - Assistant Section

    private var assistantSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Assistant")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.contentDefault)

            Button {
                selection = .assistant
            } label: {
                HStack(spacing: VSpacing.md) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        HStack(spacing: VSpacing.sm) {
                            Text(cachedAssistantDisplayName)
                                .font(VFont.bodyBold)
                                .foregroundColor(VColor.contentDefault)
                                .lineLimit(1)

                            Text("Assistant")
                                .font(VFont.small)
                                .foregroundColor(VColor.auxWhite)
                                .padding(.horizontal, VSpacing.sm)
                                .padding(.vertical, VSpacing.xxs)
                                .background(VColor.primaryBase)
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
                        }

                        Text(assistantChannelSummary)
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                            .lineLimit(1)
                    }

                    Spacer()
                }
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(selection == .assistant ? VColor.contentEmphasized.opacity(0.08) : (isAssistantHovered ? VColor.contentEmphasized.opacity(0.04) : Color.clear))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hovering in
                isAssistantHovered = hovering
            }
            .vCard(background: VColor.surfaceOverlay)
        }
    }

    /// Summarizes which assistant channels are configured.
    private var assistantChannelSummary: String {
        var channels: [String] = []
        if store?.telegramHasBotToken == true { channels.append("Telegram") }
        if store?.slackChannelHasBotToken == true && store?.slackChannelHasAppToken == true { channels.append("Slack") }
        if store?.twilioHasCredentials == true { channels.append("Phone") }
        if store?.assistantEmail != nil { channels.append("Email") }
        return channels.isEmpty ? "No channels configured" : channels.joined(separator: ", ")
    }

    // MARK: - Guardian Section

    private func guardianSection(_ contact: ContactPayload) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Me")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.contentDefault)

            Button {
                selection = .contact(contact.id)
            } label: {
                HStack(spacing: VSpacing.md) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        HStack(spacing: VSpacing.sm) {
                            Text(contact.displayName)
                                .font(VFont.bodyBold)
                                .foregroundColor(VColor.contentDefault)
                                .lineLimit(1)

                            Text("Guardian")
                                .font(VFont.small)
                                .foregroundColor(VColor.auxWhite)
                                .padding(.horizontal, VSpacing.sm)
                                .padding(.vertical, VSpacing.xxs)
                                .background(VColor.primaryBase)
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
                        }

                        if !contact.channels.isEmpty {
                            Text(channelSummary(contact.channels))
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentSecondary)
                                .lineLimit(1)
                        }
                    }

                    Spacer()

                    statusIndicator(for: contact)
                }
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(selection == .contact(contact.id) ? VColor.contentEmphasized.opacity(0.08) : (hoveredContactId == contact.id ? VColor.contentEmphasized.opacity(0.04) : Color.clear))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hovering in
                hoveredContactId = hovering ? contact.id : nil
            }
            .vCard(background: VColor.surfaceOverlay)
        }
    }

    // MARK: - Other Contacts Section

    private var otherContactsSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            HStack {
                Text("Contacts")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.contentDefault)
                Spacer()
                Button { viewModel.isCreatingContact = true } label: {
                    VIconView(.plus, size: 14)
                        .foregroundColor(VColor.primaryBase)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add contact")
            }

            if viewModel.hasNonGuardianContacts {
                searchBar
            }

            if !viewModel.hasNonGuardianContacts {
                Text("No contacts yet. Tap + to add one.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                    .padding(VSpacing.lg)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .vCard(background: VColor.surfaceOverlay)
            } else if !viewModel.otherContacts.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(viewModel.otherContacts.enumerated()), id: \.element.id) { index, contact in
                        if index > 0 {
                            Divider().background(VColor.borderBase)
                        }
                        contactRow(contact)
                    }
                }
                .vCard(background: VColor.surfaceOverlay)
            }
        }
    }

    // MARK: - Contact Row

    private func contactRow(_ contact: ContactPayload) -> some View {
        Button {
            selection = .contact(contact.id)
        } label: {
            HStack(spacing: VSpacing.md) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(contact.displayName)
                        .font(VFont.bodyBold)
                        .foregroundColor(VColor.contentDefault)
                        .lineLimit(1)

                    if let notes = contact.notes, !notes.isEmpty {
                        Text(notes.components(separatedBy: .newlines).first ?? notes)
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                            .lineLimit(1)
                    }

                    if !contact.channels.isEmpty {
                        channelIconsRow(contact.channels)
                    }
                }

                Spacer()

                statusIndicator(for: contact)
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selection == .contact(contact.id) ? VColor.contentEmphasized.opacity(0.08) : (hoveredContactId == contact.id ? VColor.contentEmphasized.opacity(0.04) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            hoveredContactId = hovering ? contact.id : nil
        }
    }

    // MARK: - Channel Icons Row

    private func channelIconsRow(_ channels: [ContactChannelPayload]) -> some View {
        HStack(spacing: VSpacing.sm) {
            let channelTypes = Set(channels.map(\.type))
            ForEach(Array(channelTypes.sorted()), id: \.self) { type in
                VIconView(channelIcon(for: type), size: 11)
                    .foregroundColor(VColor.contentTertiary)
                    .help(channelLabel(for: type))
            }
        }
    }

    // MARK: - Status Indicator

    private func statusIndicator(for contact: ContactPayload) -> some View {
        let status = aggregateChannelStatus(contact.channels)
        return Circle()
            .fill(status.color)
            .frame(width: 8, height: 8)
            .help(status.label)
    }

    // MARK: - Loading State

    private var loadingState: some View {
        VStack(spacing: VSpacing.md) {
            ProgressView()
                .controlSize(.regular)
            Text("Loading contacts...")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.xxxl)
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: VSpacing.md) {
            VIconView(.users, size: 32)
                .foregroundColor(VColor.contentTertiary)
            Text("No contacts yet")
                .font(VFont.headline)
                .foregroundColor(VColor.contentDefault)
            Text("Contacts are created automatically when people interact with your assistant, or you can add one manually.")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 300)
            VButton(label: "Add Contact", leftIcon: VIcon.plus.rawValue, style: .primary) {
                viewModel.isCreatingContact = true
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.xxxl)
    }

    // MARK: - Helpers

    /// Summarizes channel types into a human-readable string (e.g. "Telegram, Voice").
    private func channelSummary(_ channels: [ContactChannelPayload]) -> String {
        let types = Set(channels.map(\.type))
        return types.sorted().map { channelLabel(for: $0) }.joined(separator: ", ")
    }

    /// Maps channel type to a VIcon.
    private func channelIcon(for type: String) -> VIcon {
        switch type {
        case "telegram": return .send
        case "phone": return .phoneCall
        case "email": return .mail
        case "slack": return .hash
        default: return .messageCircle
        }
    }

    /// Maps channel type to a human-readable label.
    private func channelLabel(for type: String) -> String {
        switch type {
        case "telegram": return "Telegram"
        case "phone": return "Phone"
        case "email": return "Email"
        case "slack": return "Slack"
        default: return type.capitalized
        }
    }

    /// Aggregates channel statuses into a single status indicator.
    /// Green = all active/verified, Yellow = some pending, Red = any blocked/revoked.
    private func aggregateChannelStatus(_ channels: [ContactChannelPayload]) -> (color: Color, label: String) {
        guard !channels.isEmpty else {
            return (VColor.contentTertiary, "No channels")
        }

        let hasBlocked = channels.contains { $0.status == "blocked" || $0.status == "revoked" }
        let hasPending = channels.contains { $0.status == "pending" || $0.status == "unverified" }

        if hasBlocked {
            return (VColor.systemNegativeStrong, "Some channels blocked or revoked")
        } else if hasPending {
            return (VColor.systemNegativeHover, "Some channels pending verification")
        } else {
            return (VColor.systemPositiveStrong, "All channels active")
        }
    }
}

// MARK: - Preview

#Preview {
    let viewModel = ContactsViewModel(daemonClient: nil)

    // Populate with sample data for preview
    let _ = {
        viewModel.contacts = [
            ContactPayload(
                id: "guardian-1",
                displayName: "Noah",
                role: "guardian",
                lastInteraction: Date().timeIntervalSince1970 * 1000,
                interactionCount: 42,
                channels: [
                    ContactChannelPayload(
                        id: "ch-1", type: "telegram", address: "@noah",
                        isPrimary: true, status: "verified", policy: "allow"
                    ),
                    ContactChannelPayload(
                        id: "ch-3", type: "phone", address: "+15551234567",
                        isPrimary: false, status: "verified", policy: "allow"
                    ),
                ]
            ),
            ContactPayload(
                id: "contact-2",
                displayName: "Alice Chen",
                role: "contact",
                notes: "Colleague",
                lastInteraction: Date().timeIntervalSince1970 * 1000 - 86400000,
                interactionCount: 15,
                channels: [
                    ContactChannelPayload(
                        id: "ch-4", type: "telegram", address: "@alice_c",
                        isPrimary: true, status: "verified", policy: "allow"
                    ),
                ]
            ),
            ContactPayload(
                id: "contact-3",
                displayName: "Bob Williams",
                role: "contact",
                notes: "Friend",
                lastInteraction: nil,
                interactionCount: 3,
                channels: [
                    ContactChannelPayload(
                        id: "ch-5", type: "email", address: "bob@example.com",
                        isPrimary: true, status: "pending", policy: "ask"
                    ),
                ]
            ),
        ]
    }()

    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
        ScrollView {
            ContactsListView(
                viewModel: viewModel,
                selection: .constant(.assistant)
            )
            .padding(VSpacing.lg)
        }
    }
    .frame(width: 500, height: 600)
}
