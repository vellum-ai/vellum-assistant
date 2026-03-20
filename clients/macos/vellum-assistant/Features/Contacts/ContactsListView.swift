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
            // System contacts (always visible, not affected by search)
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                contactListRow(
                    name: "Your Assistant",
                    role: "assistant",
                    isSelected: selection == .assistant,
                    isHovered: isAssistantHovered,
                    onTap: { selection = .assistant },
                    onHover: { isAssistantHovered = $0 }
                )

                if let guardian = viewModel.guardianContact {
                    contactListRow(
                        name: "You",
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
                // No contacts yet — full-width add button matching contact row height
                addContactButton
            } else {
                // Search + Add button
                HStack(spacing: VSpacing.sm) {
                    searchBar
                    VButton(label: "Add", iconOnly: VIcon.plus.rawValue, style: .ghost, size: .compact) {
                        viewModel.isCreatingContact = true
                    }
                    .accessibilityLabel("Add contact")
                }

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
        .padding(.trailing, VSpacing.lg)
        .padding(.bottom, VSpacing.lg)
        .frame(maxHeight: .infinity, alignment: .top)
    }

    /// Whether a name matches the current search query (or query is empty).
    private func matchesSearch(_ name: String) -> Bool {
        let query = viewModel.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return true }
        return name.lowercased().contains(query.lowercased())
    }

    // MARK: - Add Contact Button

    @State private var isAddContactHovered = false

    private var addContactButton: some View {
        Button {
            viewModel.isCreatingContact = true
        } label: {
            HStack(spacing: VSpacing.sm) {
                Image(systemName: "person.badge.plus")
                    .font(.system(size: 14))
                Text("Add Contact")
                    .font(VFont.bodyMedium)
            }
            .foregroundColor(VColor.primaryBase)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.md)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(VColor.surfaceBase.opacity(isAddContactHovered ? 1 : 0))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isAddContactHovered = $0 }
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
        .accessibilityHidden(true)
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
