import SwiftUI
import VellumAssistantShared

/// Contacts list panel matching the Figma design: a single bordered card
/// with header, assistant/guardian rows, divider, search, and contact rows
/// with colored role tags and channel name text.
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
            // Header: "Contacts" + add button
            HStack {
                Text("Contacts")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.contentEmphasized)
                Spacer()
                VButton(label: "Add", iconOnly: VIcon.plus.rawValue, style: .outlined, size: .compact) {
                    viewModel.isCreatingContact = true
                }
                .accessibilityLabel("Add contact")
            }

            // All rows in a single scrollable area
            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    // Assistant row
                    contactListRow(
                        name: cachedAssistantDisplayName,
                        channelText: "Assistant channels",
                        tag: "Assistant",
                        tagColor: VColor.tagAssistant,
                        isSelected: selection == .assistant,
                        isHovered: isAssistantHovered,
                        onTap: { selection = .assistant },
                        onHover: { isAssistantHovered = $0 }
                    )

                    // Guardian row
                    if let guardian = viewModel.guardianContact {
                        contactListRow(
                            name: "\(guardian.displayName) (You)",
                            channelText: channelNamesText(guardian.channels),
                            tag: "Guardian",
                            tagColor: VColor.tagGuardian,
                            isSelected: selection == .contact(guardian.id),
                            isHovered: hoveredContactId == guardian.id,
                            onTap: { selection = .contact(guardian.id) },
                            onHover: { hoveredContactId = $0 ? guardian.id : nil }
                        )
                    }

                    // Divider between pinned rows and contacts
                    VColor.surfaceBase.frame(height: 1)

                    // Search + contact rows
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        if viewModel.hasNonGuardianContacts {
                            searchBar
                                .padding(.top, VSpacing.sm)
                        }

                        if !viewModel.hasNonGuardianContacts {
                            VEmptyState(
                                title: "No contacts yet",
                                icon: VIcon.users.rawValue,
                                actionLabel: "Add Contact",
                                actionIcon: VIcon.plus.rawValue,
                                action: { viewModel.isCreatingContact = true }
                            )
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, VSpacing.lg)
                        } else {
                            ForEach(viewModel.otherContacts, id: \.id) { contact in
                                contactListRow(
                                    name: contact.displayName,
                                    channelText: channelNamesText(contact.channels),
                                    tag: formatContactType(contact.role),
                                    tagColor: tagColor(for: contact.role),
                                    isSelected: selection == .contact(contact.id),
                                    isHovered: hoveredContactId == contact.id,
                                    onTap: { selection = .contact(contact.id) },
                                    onHover: { hoveredContactId = $0 ? contact.id : nil }
                                )
                            }

                            // No search results
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
                }
            }
        }
        .padding(VSpacing.lg)
        .frame(maxHeight: .infinity, alignment: .top)
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .stroke(VColor.borderDisabled, lineWidth: 2)
        )
    }

    // MARK: - Contact List Row

    private func contactListRow(
        name: String,
        channelText: String,
        tag: String,
        tagColor: Color,
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
                        .foregroundColor(VColor.contentDefault)
                        .lineLimit(1)

                    Text(channelText)
                        .font(VFont.small)
                        .foregroundColor(VColor.contentTertiary)
                        .lineLimit(1)
                }

                Spacer()

                Text(tag)
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.contentDefault)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)
                    .background(tagColor)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm + 2))
            }
            .padding(VSpacing.sm)
            .background(
                isSelected
                    ? VColor.surfaceActive
                    : (isHovered ? VColor.surfaceActive.opacity(0.5) : VColor.surfaceOverlay)
            )
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover(perform: onHover)
    }

    // MARK: - Search Bar

    private var searchBar: some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(.search, size: 12)
                .foregroundColor(VColor.contentTertiary)
            TextField("Search Contacts", text: $viewModel.searchQuery)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
        }
        .padding(VSpacing.sm)
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
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

    private func tagColor(for role: String?) -> Color {
        switch role {
        case "guardian": return VColor.tagGuardian
        case "assistant": return VColor.tagAssistant
        default: return VColor.tagHuman
        }
    }
}
