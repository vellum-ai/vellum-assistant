import SwiftUI
import VellumAssistantShared

/// Contacts list panel for the Settings > Contacts page.
@MainActor
struct ContactsListView: View {
    @Bindable var viewModel: ContactsViewModel
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
            let info = await IdentityInfo.loadAsync()
            cachedAssistantDisplayName = AssistantDisplayName.firstUserFacing(from: [info?.name]) ?? AssistantDisplayName.placeholder
        }
        .onReceive(NotificationCenter.default.publisher(for: .identityChanged)) { _ in
            Task {
                let info = await IdentityInfo.loadAsync()
                cachedAssistantDisplayName = AssistantDisplayName.firstUserFacing(from: [info?.name]) ?? AssistantDisplayName.placeholder
            }
        }
    }

    // MARK: - Contacts Card

    private var contactsCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Header: "Entries" title + add button
            HStack {
                Text("Entries")
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
                Spacer()
                VButton(label: "Add", iconOnly: VIcon.plus.rawValue, style: .ghost, size: .compact) {
                    viewModel.isCreatingContact = true
                }
                .accessibilityLabel("Add contact")
            }

            // System contacts (always visible, not affected by search)
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                if let guardian = viewModel.guardianContact {
                    contactListRow(
                        name: "You",
                        subtitle: channelTypesLabel(for: guardian.channels),
                        badgeKind: ContactTypeBadge.Kind(role: guardian.role, contactType: guardian.contactType),
                        isSelected: selection == .contact(guardian.id),
                        isHovered: hoveredContactId == guardian.id,
                        onTap: { selection = .contact(guardian.id) },
                        onHover: { hoveredContactId = $0 ? guardian.id : nil }
                    )
                }

                contactListRow(
                    name: cachedAssistantDisplayName,
                    subtitle: nil,
                    badgeKind: .assistant,
                    isSelected: selection == .assistant,
                    isHovered: isAssistantHovered,
                    onTap: { selection = .assistant },
                    onHover: { isAssistantHovered = $0 }
                )
            }

            SettingsDivider()

            if viewModel.regularContacts.isEmpty && viewModel.searchQuery.isEmpty {
                addContactButton
            } else {
                if !viewModel.regularContacts.isEmpty || !viewModel.searchQuery.isEmpty {
                    searchBar
                }

                ScrollView {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        ForEach(viewModel.filteredRegularContacts, id: \.id) { contact in
                            contactListRow(
                                name: contact.displayName,
                                subtitle: channelTypesLabel(for: contact.channels),
                                badgeKind: ContactTypeBadge.Kind(role: contact.role, contactType: contact.contactType),
                                isSelected: selection == .contact(contact.id),
                                isHovered: hoveredContactId == contact.id,
                                onTap: { selection = .contact(contact.id) },
                                onHover: { hoveredContactId = $0 ? contact.id : nil }
                            )
                        }

                        if viewModel.filteredRegularContacts.isEmpty {
                            VStack(spacing: VSpacing.sm) {
                                Text("No matching contacts")
                                    .font(VFont.bodyMediumLighter)
                                    .foregroundStyle(VColor.contentSecondary)
                                Text("Try a different search term")
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentTertiary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, VSpacing.xl)
                        }
                    }
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceLift)
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
                    .font(VFont.bodyMediumDefault)
            }
            .foregroundStyle(VColor.primaryBase)
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
        subtitle: String?,
        badgeKind: ContactTypeBadge.Kind,
        isSelected: Bool,
        isHovered: Bool,
        onTap: @escaping () -> Void,
        onHover: @escaping (Bool) -> Void
    ) -> some View {
        Button(action: onTap) {
            HStack(spacing: VSpacing.xs) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(isSelected ? VColor.contentEmphasized : VColor.contentSecondary)
                        .lineLimit(1)

                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                            .lineLimit(1)
                    }
                }

                Spacer()

                ContactTypeBadge(kind: badgeKind)
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

    private func channelTypesLabel(for channels: [ContactChannelPayload]) -> String? {
        let types = Set(channels.filter { $0.status != "revoked" }.map { $0.type })
        guard !types.isEmpty else { return nil }
        let labels: [String: String] = [
            "slack": "Slack",
            "telegram": "Telegram",
            "phone": "Phone",
            "email": "Email",
            "whatsapp": "WhatsApp",
        ]
        let ordered = ["email", "slack", "telegram", "phone", "whatsapp"]
        let result = ordered.compactMap { type in
            types.contains(type) ? labels[type] : nil
        }
        return result.isEmpty ? nil : result.joined(separator: " | ")
    }

    private func rowBackground(isSelected: Bool, isHovered: Bool) -> some View {
        RoundedRectangle(cornerRadius: VRadius.md)
            .fill(
                isSelected
                    ? VColor.surfaceActive
                    : VColor.surfaceBase.opacity(isHovered ? 1 : 0)
            )
    }
}
