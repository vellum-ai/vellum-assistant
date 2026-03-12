#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct ContactsListView: View {
    @ObservedObject var contactsStore: ContactsStore
    @State private var searchQuery = ""
    @State private var contactToDelete: ContactPayload?
    @State private var showDeleteConfirmation = false

    private var filteredGuardian: ContactPayload? {
        guard let guardian = contactsStore.guardianContact else { return nil }
        if searchQuery.isEmpty { return guardian }
        return guardian.displayName.localizedCaseInsensitiveContains(searchQuery) ? guardian : nil
    }

    private var filteredContacts: [ContactPayload] {
        let others = contactsStore.otherContacts
        if searchQuery.isEmpty { return others }
        return others.filter { $0.displayName.localizedCaseInsensitiveContains(searchQuery) }
    }

    var body: some View {
        Group {
            if contactsStore.isLoading && contactsStore.contacts.isEmpty {
                loadingState
            } else if contactsStore.contacts.isEmpty {
                emptyState
            } else {
                contactsList
            }
        }
        .navigationTitle("Contacts")
        .searchable(text: $searchQuery, prompt: "Filter contacts...")
        .refreshable {
            contactsStore.loadContacts()
        }
        .alert("Delete Contact", isPresented: $showDeleteConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) {
                if let contact = contactToDelete {
                    contactsStore.deleteContact(id: contact.id)
                }
            }
        } message: {
            if let contact = contactToDelete {
                Text("Are you sure you want to delete \"\(contact.displayName)\"? This action cannot be undone.")
            }
        }
    }

    // MARK: - Contacts List

    private var contactsList: some View {
        List {
            // Guardian section
            if let guardian = filteredGuardian {
                Section("Guardian") {
                    NavigationLink {
                        ContactDetailView(contact: guardian, contactsStore: contactsStore)
                    } label: {
                        contactRow(guardian)
                    }
                }
            }

            // Other contacts section
            if !filteredContacts.isEmpty {
                Section("Contacts") {
                    ForEach(filteredContacts) { contact in
                        NavigationLink {
                            ContactDetailView(contact: contact, contactsStore: contactsStore)
                        } label: {
                            contactRow(contact)
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                contactToDelete = contact
                                showDeleteConfirmation = true
                            } label: {
                                Label { Text("Delete") } icon: { VIconView(.trash, size: 12) }
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Contact Row

    private func contactRow(_ contact: ContactPayload) -> some View {
        HStack(spacing: VSpacing.sm) {
            // Initials circle
            initialsView(for: contact.displayName)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(contact.displayName)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentDefault)

                    roleBadge(contact.role)
                }

                if !contact.channels.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(contact.channels) { channel in
                            channelIcon(channel.type)
                        }
                    }
                }
            }

            Spacer()

            if contact.interactionCount > 0 {
                Text("\(contact.interactionCount)")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Contact: \(contact.displayName), \(contact.role)\(contact.interactionCount > 0 ? ", \(contact.interactionCount) interactions" : "")")
        .accessibilityHint("Opens contact details")
    }

    // MARK: - Initials

    private func initialsView(for name: String) -> some View {
        let initials = name.split(separator: " ")
            .prefix(2)
            .compactMap { $0.first.map(String.init) }
            .joined()
            .uppercased()

        return Text(initials.isEmpty ? "?" : initials)
            .font(VFont.caption)
            .foregroundColor(.white)
            .frame(width: 32, height: 32)
            .background(Circle().fill(VColor.primaryBase))
            .accessibilityHidden(true)
    }

    // MARK: - Role Badge

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
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.15)))
            .foregroundColor(color)
    }

    // MARK: - Channel Icon

    private func channelIcon(_ type: String) -> some View {
        let icon: VIcon = {
            switch type {
            case "email": return .mail
            case "phone": return .phone
            case "slack": return .hash
            case "discord": return .messageCircle
            case "telegram": return .send
            default: return .link
            }
        }()

        return VIconView(icon, size: 10)
            .foregroundColor(VColor.contentTertiary)
    }

    // MARK: - Empty States

    private var emptyState: some View {
        VStack(spacing: VSpacing.lg) {
            VIconView(.users, size: 48)
                .foregroundColor(VColor.contentTertiary)
                .accessibilityHidden(true)

            Text("No Contacts")
                .font(VFont.title)
                .foregroundColor(VColor.contentDefault)

            Text("Contacts will appear here as people interact with your assistant.")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("No contacts. Contacts will appear here as people interact with your assistant.")
    }

    private var loadingState: some View {
        VStack(spacing: VSpacing.md) {
            ProgressView()
            Text("Loading contacts...")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
#endif
