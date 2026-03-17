import SwiftUI
import VellumAssistantShared

/// Contacts list panel for the Settings > Contacts page.
@MainActor
struct ContactsListView: View {
    @ObservedObject var viewModel: ContactsViewModel
    @Binding var selection: ContactSelection?

    @State private var hoveredContactId: String?
    @State private var isAssistantHovered = false
    @State private var cachedAssistantDisplayName: String = AssistantDisplayName.placeholder

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if viewModel.isLoading && viewModel.contacts.isEmpty {
                loadingState
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if viewModel.contacts.isEmpty {
                emptyState
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                contactsCard
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
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

    // MARK: - Contacts Card

    private var contactsCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            HStack {
                Text("Contacts")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.contentEmphasized)
                Spacer()
                VButton(label: "Add", iconOnly: VIcon.plus.rawValue, style: .ghost, size: .compact) {
                    viewModel.isCreatingContact = true
                }
                .accessibilityLabel("Add contact")
            }

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                contactListRow(
                    name: cachedAssistantDisplayName,
                    channelText: "Assistant channels",
                    tag: "Assistant",
                    isSelected: selection == .assistant,
                    isHovered: isAssistantHovered,
                    onTap: { selection = .assistant },
                    onHover: { isAssistantHovered = $0 }
                )

                if let guardian = viewModel.guardianContact {
                    contactListRow(
                        name: "\(guardian.displayName) (You)",
                        channelText: channelNamesText(guardian.channels),
                        tag: "Guardian",
                        isSelected: selection == .contact(guardian.id),
                        isHovered: hoveredContactId == guardian.id,
                        onTap: { selection = .contact(guardian.id) },
                        onHover: { hoveredContactId = $0 ? guardian.id : nil }
                    )
                }
            }

            SettingsDivider()

            searchBar

            if viewModel.hasNonGuardianContacts {
                ScrollView {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        ForEach(viewModel.otherContacts, id: \.id) { contact in
                            contactListRow(
                                name: contact.displayName,
                                channelText: channelNamesText(contact.channels),
                                tag: formatContactType(contact.role),
                                isSelected: selection == .contact(contact.id),
                                isHovered: hoveredContactId == contact.id,
                                onTap: { selection = .contact(contact.id) },
                                onHover: { hoveredContactId = $0 ? contact.id : nil }
                            )
                        }

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
            } else {
                // Empty state centered in remaining space
                Spacer()
                VEmptyState(
                    title: "No contacts yet",
                    icon: VIcon.users.rawValue,
                    actionLabel: "Add Contact",
                    actionIcon: VIcon.plus.rawValue,
                    action: { viewModel.isCreatingContact = true }
                )
                .frame(maxWidth: .infinity)
                Spacer()
            }
        }
        .padding(VSpacing.lg)
        .frame(maxHeight: .infinity, alignment: .top)
        .vCard(radius: VRadius.lg, background: VColor.surfaceOverlay)
    }

    // MARK: - Contact List Row

    private func contactListRow(
        name: String,
        channelText: String,
        tag: String,
        isSelected: Bool,
        isHovered: Bool,
        onTap: @escaping () -> Void,
        onHover: @escaping (Bool) -> Void
    ) -> some View {
        Button(action: onTap) {
            HStack(spacing: VSpacing.xs) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .font(VFont.bodyMedium)
                        .foregroundColor(isSelected ? VColor.contentEmphasized : VColor.contentDefault)
                        .lineLimit(1)

                    Text(channelText)
                        .font(VFont.small)
                        .foregroundColor(isSelected ? VColor.contentSecondary : VColor.contentTertiary)
                        .lineLimit(1)
                }

                Spacer()

                VBadge(label: tag, tone: .neutral)
            }
            .padding(VSpacing.sm)
            .background(rowBackground(isSelected: isSelected, isHovered: isHovered))
            .overlay(rowBorder(isSelected: isSelected, isHovered: isHovered))
            .overlay(alignment: .leading) {
                Capsule()
                    .fill(isSelected ? VColor.primaryBase : .clear)
                    .frame(width: 4)
                    .padding(.vertical, VSpacing.sm)
                    .padding(.leading, 2)
            }
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .contentShape(RoundedRectangle(cornerRadius: VRadius.md))
        }
        .buttonStyle(.plain)
        .onHover(perform: onHover)
    }

    // MARK: - Search Bar

    private var searchBar: some View {
        VSearchBar(placeholder: "Search Contacts", text: $viewModel.searchQuery)
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
    }

    // MARK: - Helpers

    private func channelNamesText(_ channels: [ContactChannelPayload]) -> String {
        let activeTypes = Set(channels.filter { $0.status != "revoked" }.map(\.type))
        guard !activeTypes.isEmpty else { return "No channels" }
        return activeTypes.sorted().map { channelLabel(for: $0) }.joined(separator: " | ")
    }

    private func channelLabel(for type: String) -> String {
        switch type {
        case "telegram": return "Telegram"
        case "whatsapp": return "WhatsApp"
        case "phone": return "Phone"
        case "email": return "Email"
        case "slack": return "Slack"
        default: return type.capitalized
        }
    }

    private func formatContactType(_ role: String?) -> String {
        switch role {
        case "guardian": return "Guardian"
        case "assistant": return "Assistant"
        default: return "Human"
        }
    }

    private func rowBackground(isSelected: Bool, isHovered: Bool) -> some View {
        RoundedRectangle(cornerRadius: VRadius.md)
            .fill(
                isSelected
                    ? VColor.primaryBase.opacity(0.10)
                    : (isHovered ? VColor.surfaceBase : Color.clear)
            )
    }

    private func rowBorder(isSelected: Bool, isHovered: Bool) -> some View {
        RoundedRectangle(cornerRadius: VRadius.md)
            .strokeBorder(
                isSelected
                    ? VColor.borderActive
                    : (isHovered ? VColor.borderBase.opacity(0.45) : Color.clear),
                lineWidth: 1
            )
    }
}
