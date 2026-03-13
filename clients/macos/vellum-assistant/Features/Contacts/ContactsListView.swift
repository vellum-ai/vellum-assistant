import SwiftUI
import VellumAssistantShared

/// Displays the list of contacts in a single "Entries" card, with the assistant
/// and guardian rows at the top, a search bar, and a scrollable list of contacts
/// with role badges, channel badges, and overflow menus.
@MainActor
struct ContactsListView: View {
    @ObservedObject var viewModel: ContactsViewModel
    @Binding var selection: ContactSelection?

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
                entriesCard
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

    // MARK: - Entries Card

    private var entriesCard: some View {
        SettingsCard(title: "Entries") {
            Button { viewModel.isCreatingContact = true } label: {
                VIconView(.plus, size: 14)
                    .foregroundColor(VColor.primaryBase)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Add contact")
        } content: {
            VStack(spacing: 0) {
                // Assistant row
                assistantRow

                SettingsDivider()

                // Guardian row
                if let guardian = viewModel.guardianContact {
                    guardianRow(guardian)
                    SettingsDivider()
                }

                // Search bar (only when contacts exist)
                if viewModel.hasNonGuardianContacts {
                    searchBar
                        .padding(.vertical, VSpacing.sm)
                    SettingsDivider()
                }

                // Other contacts
                if !viewModel.hasNonGuardianContacts {
                    noContactsRow
                } else if viewModel.otherContacts.isEmpty {
                    // Search yielded no results
                    noMatchRow
                } else {
                    ForEach(Array(viewModel.otherContacts.enumerated()), id: \.element.id) { index, contact in
                        if index > 0 {
                            SettingsDivider()
                        }
                        contactRow(contact)
                    }
                }
            }
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
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
    }

    // MARK: - Assistant Row

    private var assistantRow: some View {
        Button {
            selection = .assistant
        } label: {
            HStack(spacing: VSpacing.md) {
                initialsView(for: cachedAssistantDisplayName, color: VColor.primaryBase)

                Text(cachedAssistantDisplayName)
                    .font(VFont.bodyBold)
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(1)

                roleBadge("Assistant", color: VColor.primaryBase)

                Spacer()
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.md)
            .background(selection == .assistant ? VColor.contentEmphasized.opacity(0.08) : (isAssistantHovered ? VColor.contentEmphasized.opacity(0.04) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            isAssistantHovered = hovering
        }
    }

    // MARK: - Guardian Row

    private func guardianRow(_ contact: ContactPayload) -> some View {
        Button {
            selection = .contact(contact.id)
        } label: {
            HStack(spacing: VSpacing.md) {
                initialsView(for: contact.displayName, color: VColor.primaryBase)

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack(spacing: VSpacing.sm) {
                        Text(contact.displayName)
                            .font(VFont.bodyBold)
                            .foregroundColor(VColor.contentDefault)
                            .lineLimit(1)

                        roleBadge("Guardian", color: VColor.primaryBase)
                    }

                    if !contact.channels.isEmpty {
                        channelBadgesRow(contact.channels)
                    }
                }

                Spacer()

                overflowMenu(for: contact)
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.md)
            .background(selection == .contact(contact.id) ? VColor.contentEmphasized.opacity(0.08) : (hoveredContactId == contact.id ? VColor.contentEmphasized.opacity(0.04) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            hoveredContactId = hovering ? contact.id : nil
        }
    }

    // MARK: - Contact Row

    private func contactRow(_ contact: ContactPayload) -> some View {
        Button {
            selection = .contact(contact.id)
        } label: {
            HStack(spacing: VSpacing.md) {
                initialsView(for: contact.displayName, color: VColor.contentTertiary)

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack(spacing: VSpacing.sm) {
                        Text(contact.displayName)
                            .font(VFont.bodyBold)
                            .foregroundColor(VColor.contentDefault)
                            .lineLimit(1)

                        roleBadge("Human", color: VColor.contentSecondary)
                    }

                    if !contact.channels.isEmpty {
                        channelBadgesRow(contact.channels)
                    }
                }

                Spacer()

                overflowMenu(for: contact)
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.md)
            .background(selection == .contact(contact.id) ? VColor.contentEmphasized.opacity(0.08) : (hoveredContactId == contact.id ? VColor.contentEmphasized.opacity(0.04) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            hoveredContactId = hovering ? contact.id : nil
        }
    }

    // MARK: - No Contacts / No Match

    private var noContactsRow: some View {
        VStack(spacing: VSpacing.sm) {
            Text("No contacts yet")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
            Text("Contacts are created when people interact with your assistant, or you can add one manually.")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.xl)
    }

    private var noMatchRow: some View {
        VStack(spacing: VSpacing.sm) {
            Text("No matching contacts")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
            Text("Try a different search term")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.lg)
    }

    // MARK: - Initials Avatar

    private func initialsView(for name: String, color: Color) -> some View {
        let initials = name.split(separator: " ")
            .prefix(2)
            .compactMap { $0.first.map(String.init) }
            .joined()
            .uppercased()

        return Text(initials.isEmpty ? "?" : initials)
            .font(VFont.caption)
            .foregroundColor(VColor.auxWhite)
            .frame(width: 28, height: 28)
            .background(Circle().fill(color))
            .accessibilityHidden(true)
    }

    // MARK: - Role Badge

    private func roleBadge(_ role: String, color: Color) -> some View {
        Text(role)
            .font(VFont.caption)
            .foregroundColor(color)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xxs)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }

    // MARK: - Channel Badges Row

    private func channelBadgesRow(_ channels: [ContactChannelPayload]) -> some View {
        HStack(spacing: VSpacing.xs) {
            let activeChannels = channels.filter { $0.status != "revoked" }
            let channelTypes = Array(Set(activeChannels.map(\.type)).sorted())
            ForEach(channelTypes, id: \.self) { type in
                channelBadge(for: type)
            }
        }
    }

    private func channelBadge(for type: String) -> some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(channelIcon(for: type), size: 10)
            Text(channelLabel(for: type))
                .font(VFont.caption)
        }
        .foregroundColor(VColor.contentTertiary)
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xxs)
        .background(VColor.surfaceActive)
        .clipShape(Capsule())
    }

    // MARK: - Overflow Menu

    private func overflowMenu(for contact: ContactPayload) -> some View {
        Menu {
            Button {
                selection = .contact(contact.id)
            } label: {
                Label { Text("View Details") } icon: { VIconView(.user, size: 12) }
            }
        } label: {
            VIconView(.ellipsis, size: 14)
                .foregroundColor(VColor.contentTertiary)
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
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

    private func channelIcon(for type: String) -> VIcon {
        switch type {
        case "telegram": return .send
        case "phone": return .phoneCall
        case "email": return .mail
        case "slack": return .hash
        case "whatsapp": return .messageCircle
        default: return .messageCircle
        }
    }

    private func channelLabel(for type: String) -> String {
        switch type {
        case "telegram": return "Telegram"
        case "phone": return "Phone"
        case "email": return "Email"
        case "slack": return "Slack"
        case "whatsapp": return "WhatsApp"
        default: return type.capitalized
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
