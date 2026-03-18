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

            // Sticky system contacts (always visible, not affected by search)
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                contactListRow(
                    name: cachedAssistantDisplayName,
                    role: "assistant",
                    isSelected: selection == .assistant,
                    isHovered: isAssistantHovered,
                    onTap: { selection = .assistant },
                    onHover: { isAssistantHovered = $0 }
                )

                if let guardian = viewModel.guardianContact {
                    contactListRow(
                        name: "\(guardian.displayName) (You)",
                        role: guardian.role,
                        isSelected: selection == .contact(guardian.id),
                        isHovered: hoveredContactId == guardian.id,
                        onTap: { selection = .contact(guardian.id) },
                        onHover: { hoveredContactId = $0 ? guardian.id : nil }
                    )
                }
            }

            Divider()

            if viewModel.regularContacts.isEmpty {
                regularContactsEmptyState
            } else {
                searchBar

                ScrollView {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        ForEach(viewModel.filteredRegularContacts, id: \.id) { contact in
                            contactListRow(
                                name: contact.displayName,
                                role: contact.role,
                                isSelected: selection == .contact(contact.id),
                                isHovered: hoveredContactId == contact.id,
                                onTap: { selection = .contact(contact.id) },
                                onHover: { hoveredContactId = $0 ? contact.id : nil }
                            )
                        }

                        if viewModel.filteredRegularContacts.isEmpty {
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
        .padding(VSpacing.lg)
        .frame(maxHeight: .infinity, alignment: .top)
        .vCard(radius: VRadius.lg, background: VColor.surfaceOverlay)
    }

    /// Whether a name matches the current search query (or query is empty).
    private func matchesSearch(_ name: String) -> Bool {
        let query = viewModel.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return true }
        return name.lowercased().contains(query.lowercased())
    }

    // MARK: - Contact List Row

    private func contactListRow(
        name: String,
        role: String?,
        isSelected: Bool,
        isHovered: Bool,
        onTap: @escaping () -> Void,
        onHover: @escaping (Bool) -> Void
    ) -> some View {
        Button(action: onTap) {
            HStack(spacing: VSpacing.xs) {
                Text(name)
                    .font(VFont.bodyMedium)
                    .foregroundColor(isSelected ? VColor.contentEmphasized : VColor.contentSecondary)
                    .lineLimit(1)

                Spacer()

                ContactTypeBadge(role: role)
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.md)
            .background(rowBackground(isSelected: isSelected, isHovered: isHovered))
            .animation(VAnimation.fast, value: isHovered)
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
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            HStack {
                VSkeletonBone(width: 80, height: 16)
                Spacer()
                VSkeletonBone(width: 24, height: 24, radius: VRadius.xs)
            }

            VSkeletonBone(height: 28, radius: VRadius.md)

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                ForEach(0..<4, id: \.self) { _ in
                    HStack {
                        VSkeletonBone(width: 120, height: 14)
                        Spacer()
                        VSkeletonBone(width: 60, height: 12)
                    }
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.md)
                }
            }
        }
        .padding(VSpacing.lg)
        .frame(maxHeight: .infinity, alignment: .top)
        .vCard(radius: VRadius.lg, background: VColor.surfaceOverlay)
        .accessibilityHidden(true)
    }

    // MARK: - Empty State

    private var regularContactsEmptyState: some View {
        VStack(spacing: VSpacing.md) {
            VIconView(.users, size: 24)
                .foregroundColor(VColor.contentTertiary)
            Text("No contacts yet")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
            VButton(label: "Add Contact", leftIcon: VIcon.plus.rawValue, style: .primary, size: .compact) {
                viewModel.isCreatingContact = true
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, VSpacing.xl)
    }

    // MARK: - Helpers

    private func rowBackground(isSelected: Bool, isHovered: Bool) -> some View {
        RoundedRectangle(cornerRadius: VRadius.md)
            .fill(
                isSelected
                    ? VColor.surfaceActive
                    : VColor.surfaceBase.opacity(isHovered ? 1 : 0)
            )
    }
}
