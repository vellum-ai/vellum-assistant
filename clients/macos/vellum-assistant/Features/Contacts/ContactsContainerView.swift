import SwiftUI
import VellumAssistantShared

/// Selection model for the Contacts tab — either the assistant's channel
/// configuration or a specific contact.
enum ContactSelection: Hashable {
    case assistant
    case contact(String)
}

/// Master-detail container for the Contacts tab in Settings.
/// Left pane shows the contacts list; right pane shows detail for the
/// selected contact, the assistant channel configuration, or a placeholder.
@MainActor
struct ContactsContainerView: View {
    var daemonClient: DaemonClient?
    var store: SettingsStore?
    var isEmailEnabled: Bool = false

    @StateObject private var viewModel: ContactsViewModel
    @State private var selection: ContactSelection? = .assistant

    private let contactClient: ContactClientProtocol = ContactClient()

    init(daemonClient: DaemonClient?, store: SettingsStore? = nil, isEmailEnabled: Bool = false) {
        self.daemonClient = daemonClient
        self.store = store
        self.isEmailEnabled = isEmailEnabled
        _viewModel = StateObject(wrappedValue: ContactsViewModel(daemonClient: daemonClient))
    }

    var body: some View {
        HStack(alignment: .top, spacing: VSpacing.lg) {
            // Left pane: contacts list (full height, internal scrolling)
            VStack(spacing: VSpacing.sm) {
                ContactsListView(
                    viewModel: viewModel,
                    selection: $selection
                )
                .frame(maxHeight: .infinity, alignment: .top)

                if let createContactError {
                    VInlineMessage(createContactError)
                }
            }
            .frame(width: 320)
            .frame(maxHeight: .infinity, alignment: .top)
            // Right pane: detail, loading, or placeholder
            if viewModel.isLoading && viewModel.contacts.isEmpty {
                // Loading state — contacts are being fetched
                VStack(spacing: VSpacing.md) {
                    ProgressView()
                        .controlSize(.regular)
                    Text("Loading contacts...")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(VColor.surfaceOverlay)
            } else {
                switch selection {
                case .assistant:
                    assistantDetailView
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                case .contact(let contactId):
                    if let contact = viewModel.contacts.first(where: { $0.id == contactId }) {
                        if contact.role == "guardian" {
                            guardianDetailView(contact: contact)
                                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                        } else {
                            ContactDetailView(
                                contact: contact,
                                daemonClient: daemonClient,
                                store: store,
                                onDelete: {
                                    selection = .assistant
                                    viewModel.loadContacts()
                                },
                                onSelectAssistant: { selection = .assistant },
                                guardianName: viewModel.guardianContact?.displayName
                            )
                            .id(contactId)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                        }
                    }
                case nil:
                    // True empty state — contacts loaded but none selected
                    VStack(spacing: VSpacing.md) {
                        VIconView(.users, size: 36)
                            .foregroundColor(VColor.contentTertiary)
                        Text("Select a contact")
                            .font(VFont.headline)
                            .foregroundColor(VColor.contentSecondary)
                        Text("Choose a contact from the list to view their details.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 240)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(VColor.surfaceOverlay)
                }
            }
        }
        .onReceive(viewModel.$contacts) { newContacts in
            // Default to assistant on first load (don't override existing selection)
            if selection == nil && !newContacts.isEmpty {
                selection = .assistant
            }
        }
        .onChange(of: viewModel.isCreatingContact) { _, isCreating in
            if isCreating {
                Task {
                    await createPlaceholderContact()
                }
            }
        }
    }

    /// Guardian detail — editable name+notes header card, then existing channel content in a second card.
    private func guardianDetailView(contact: ContactPayload) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    // Title row: display name + badge + interaction count
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        HStack(spacing: VSpacing.sm) {
                            Text("\(contact.displayName) (You)")
                                .font(VFont.display)
                                .foregroundColor(VColor.contentDefault)
                            ContactTypeBadge(role: "guardian")
                        }
                        Text("\(contact.interactionCount) interaction\(contact.interactionCount == 1 ? "" : "s")")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                    }

                    // Editable fields
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Name")
                                .font(VFont.inputLabel)
                                .foregroundColor(VColor.contentSecondary)
                            VTextField(placeholder: "Your name", text: $guardianEditedName)
                        }

                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Notes")
                                .font(VFont.inputLabel)
                                .foregroundColor(VColor.contentSecondary)
                            VTextEditor(
                                placeholder: "Notes about yourself which AI will take into account",
                                text: $guardianEditedNotes,
                                minHeight: 80,
                                maxHeight: 180
                            )
                        }
                    }

                    // Save button
                    HStack(spacing: VSpacing.sm) {
                        VButton(
                            label: "Save",
                            style: .primary,
                            isDisabled: guardianIsSaving || guardianEditedName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ) {
                            Task { await saveGuardianEdits(contact: contact) }
                        }
                        if guardianIsSaving {
                            ProgressView()
                                .controlSize(.small)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(VSpacing.lg)
                .vCard(radius: VRadius.lg, background: VColor.surfaceOverlay)

                GuardianChannelsDetailView(
                    contact: contact,
                    daemonClient: daemonClient,
                    store: store,
                    onSelectAssistant: { selection = .assistant },
                    showCardBorders: false
                )
                .padding(VSpacing.lg)
                .vCard(radius: VRadius.lg, background: VColor.surfaceOverlay)
            }
        }
        .id(contact.id)
        .onAppear {
            guardianEditedName = contact.displayName
            guardianEditedNotes = contact.notes ?? ""
        }
        .onChange(of: contact) { _, newContact in
            guardianEditedName = newContact.displayName
            guardianEditedNotes = newContact.notes ?? ""
        }
    }

    /// Persists guardian name/notes edits via the contacts API.
    private func saveGuardianEdits(contact: ContactPayload) async {
        let trimmedName = guardianEditedName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { return }
        let trimmedNotes = guardianEditedNotes.trimmingCharacters(in: .whitespacesAndNewlines)

        guardianIsSaving = true
        do {
            if let updated = try await contactClient.updateContact(
                contactId: contact.id,
                displayName: trimmedName,
                notes: trimmedNotes.isEmpty ? nil : trimmedNotes
            ) {
                guardianEditedName = updated.displayName
                guardianEditedNotes = updated.notes ?? ""
                viewModel.loadContacts()
            }
        } catch {
            // Silently fail — user can retry
        }
        guardianIsSaving = false
    }

    @State private var guardianEditedName: String = ""
    @State private var guardianEditedNotes: String = ""
    @State private var guardianIsSaving: Bool = false
    @State private var isCreatingContact: Bool = false
    @State private var createContactError: String?

    @State private var cachedAssistantName: String = AssistantDisplayName.placeholder

    /// Assistant detail — channels card only (top summary tile removed per design review).
    @ViewBuilder
    private var assistantDetailView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                if let store {
                    AssistantChannelsDetailView(store: store, daemonClient: daemonClient, assistantName: cachedAssistantName, isEmailEnabled: isEmailEnabled, showCardBorders: false)
                        .padding(VSpacing.lg)
                        .vCard(radius: VRadius.lg, background: VColor.surfaceOverlay)
                }
            }
        }
        .task {
            cachedAssistantName = AssistantDisplayName.firstUserFacing(from: [IdentityInfo.load()?.name]) ?? AssistantDisplayName.placeholder
        }
    }

    /// Creates a placeholder contact with a default name, selects it in the
    /// list, and shows the detail pane so the user can edit inline.
    private func createPlaceholderContact() async {
        viewModel.isCreatingContact = false
        guard !isCreatingContact else { return }
        isCreatingContact = true
        createContactError = nil
        do {
            let contact = try await contactClient.createContact(
                displayName: "New Contact",
                notes: nil,
                channels: nil
            )
            if let contact {
                viewModel.loadContacts()
                // Small delay to let the contacts list refresh before selecting
                try? await Task.sleep(nanoseconds: 200_000_000)
                selection = .contact(contact.id)
            }
        } catch {
            createContactError = "Failed to create contact: \(error.localizedDescription)"
        }
        isCreatingContact = false
    }
}
