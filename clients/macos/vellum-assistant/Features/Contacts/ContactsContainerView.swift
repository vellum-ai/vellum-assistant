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
    var connectionManager: GatewayConnectionManager?
    var store: SettingsStore?
    var conversationManager: ConversationManager?
    var showToast: ((String, ToastInfo.Style) -> Void)?

    @State private var viewModel: ContactsViewModel
    @State private var selection: ContactSelection? = .assistant

    private let contactClient: ContactClientProtocol = ContactClient()

    init(connectionManager: GatewayConnectionManager?, eventStreamClient: EventStreamClient? = nil, store: SettingsStore? = nil, conversationManager: ConversationManager? = nil, showToast: ((String, ToastInfo.Style) -> Void)? = nil) {
        self.connectionManager = connectionManager
        self.store = store
        self.conversationManager = conversationManager
        self.showToast = showToast
        _viewModel = State(wrappedValue: ContactsViewModel(connectionManager: connectionManager, eventStreamClient: eventStreamClient))
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
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

            // Thin vertical separator with shadow
            VColor.borderDisabled
                .frame(width: 1)
                .frame(maxHeight: .infinity)
                .shadow(color: VColor.auxBlack.opacity(0.08), radius: 2, x: 1, y: 0)

            // Right pane: detail, loading, or placeholder (max 700pt, left-aligned)
            VStack(alignment: .leading, spacing: 0) {
            if viewModel.isLoading && viewModel.contacts.isEmpty {
                // Skeleton loading state for detail pane
                ScrollView {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        // Header card skeleton
                        VStack(alignment: .leading, spacing: VSpacing.lg) {
                            HStack(spacing: VSpacing.sm) {
                                VSkeletonBone(width: 140, height: 18)
                                VSkeletonBone(width: 60, height: 20, radius: VRadius.sm)
                            }
                            VSkeletonBone(width: 100, height: 12)
                            VStack(alignment: .leading, spacing: VSpacing.md) {
                                VStack(alignment: .leading, spacing: VSpacing.xs) {
                                    VSkeletonBone(width: 40, height: 12)
                                    VSkeletonBone(height: 28, radius: VRadius.md)
                                }
                                VStack(alignment: .leading, spacing: VSpacing.xs) {
                                    VSkeletonBone(width: 40, height: 12)
                                    VSkeletonBone(height: 80, radius: VRadius.md)
                                }
                            }
                            VSkeletonBone(width: 60, height: 28, radius: VRadius.md)
                        }
                        .padding(VSpacing.lg)

                        // Channels card skeleton
                        VStack(alignment: .leading, spacing: VSpacing.lg) {
                            VSkeletonBone(width: 80, height: 16)
                            VSkeletonBone(width: 200, height: 12)
                            VStack(alignment: .leading, spacing: 0) {
                                ForEach(0..<2, id: \.self) { index in
                                    HStack(spacing: VSpacing.sm) {
                                        VSkeletonBone(width: 16, height: 16, radius: VRadius.xs)
                                        VSkeletonBone(width: 100, height: 14)
                                        Spacer()
                                        VSkeletonBone(width: 72, height: 28, radius: VRadius.md)
                                    }
                                    .frame(minHeight: 36)
                                    .padding(.vertical, VSpacing.sm)
                                    if index < 1 {
                                        SettingsDivider()
                                    }
                                }
                            }
                        }
                        .padding(VSpacing.lg)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityHidden(true)
            } else {
                switch selection {
                case .assistant:
                    assistantDetailView
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                case .contact(let contactId):
                    if let contact = viewModel.deduplicatedContacts.first(where: { $0.id == contactId }) {
                        if contact.role == "guardian" {
                            guardianDetailView(contact: contact)
                                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                        } else {
                            ContactDetailView(
                                contact: contact,
                                connectionManager: connectionManager,
                                store: store,
                                onDelete: {
                                    selection = .assistant
                                    viewModel.loadContacts()
                                },
                                onSelectAssistant: { selection = .assistant },
                                conversationManager: conversationManager,
                                showToast: showToast,
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
                            .foregroundStyle(VColor.contentTertiary)
                        Text("Select a contact")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)
                        Text("Choose a contact from the list to view their details.")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 240)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(VColor.surfaceOverlay)
                }
            }
            }
            .frame(maxWidth: 700, maxHeight: .infinity, alignment: .leading)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
        .onChange(of: viewModel.contacts, initial: true) { _, newContacts in
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
                            Text(contact.displayName.hasPrefix("vellum-principal-") ? "You" : "\(contact.displayName) (You)")
                                .font(VFont.titleSmall)
                                .foregroundStyle(VColor.contentDefault)
                            ContactTypeBadge(role: "guardian")
                        }
                        Text("\(contact.interactionCount) interaction\(contact.interactionCount == 1 ? "" : "s")")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }

                    // Editable fields
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Name")
                                .font(VFont.bodySmallDefault)
                                .foregroundStyle(VColor.contentSecondary)
                            VTextField(placeholder: "Your name", text: $guardianEditedName)
                                .disabled(true)
                                .opacity(0.6)
                        }

                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Notes")
                                .font(VFont.bodySmallDefault)
                                .foregroundStyle(VColor.contentSecondary)
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
                            isDisabled: guardianIsSaving || (guardianEditedName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !contact.displayName.hasPrefix("vellum-principal-"))
                        ) {
                            Task { await saveGuardianEdits(contact: contact) }
                        }
                        if guardianIsSaving {
                            ProgressView()
                                .controlSize(.small)
                        }
                    }

                    if let guardianErrorMessage {
                        VInlineMessage(guardianErrorMessage)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, VSpacing.lg)
                .padding(.bottom, VSpacing.lg)

                GuardianChannelsDetailView(
                    contact: contact,
                    connectionManager: connectionManager,
                    store: store,
                    conversationManager: conversationManager,
                    onSelectAssistant: { selection = .assistant },
                    showCardBorders: false
                )
                .padding(VSpacing.lg)
            }
        }
        .scrollContentBackground(.hidden)
        .contentMargins(0)
        .id(contact.id)
        .onAppear {
            guardianEditedName = contact.displayName.hasPrefix("vellum-principal-") ? "" : contact.displayName
            guardianEditedNotes = contact.notes ?? ""
        }
        .onChange(of: contact) { _, newContact in
            // Don't reset fields while a save is in flight — the reload
            // triggers this with stale data before the API response propagates.
            guard !guardianIsSaving else { return }
            guardianEditedName = newContact.displayName.hasPrefix("vellum-principal-") ? "" : newContact.displayName
            guardianEditedNotes = newContact.notes ?? ""
        }
    }

    /// Persists guardian name/notes edits via the contacts API.
    private func saveGuardianEdits(contact: ContactPayload) async {
        let trimmedName = guardianEditedName.trimmingCharacters(in: .whitespacesAndNewlines)
        // When the name field is empty (e.g. guardian with raw principal ID), preserve the existing displayName
        let nameToSave = trimmedName.isEmpty ? contact.displayName : trimmedName
        let trimmedNotes = guardianEditedNotes.trimmingCharacters(in: .whitespacesAndNewlines)

        guardianIsSaving = true
        guardianErrorMessage = nil
        do {
            if let updated = try await contactClient.updateContact(
                contactId: contact.id,
                displayName: nameToSave,
                notes: trimmedNotes.isEmpty ? nil : trimmedNotes
            ) {
                guardianEditedName = updated.displayName.hasPrefix("vellum-principal-") ? "" : updated.displayName
                guardianEditedNotes = updated.notes ?? ""
                viewModel.loadContacts()
                showToast?("Contact saved", .success)
            } else {
                guardianErrorMessage = "Failed to save changes. Please try again."
                showToast?("Failed to save contact", .error)
            }
        } catch {
            guardianErrorMessage = "Failed to save changes. Please try again."
            showToast?("Failed to save contact", .error)
        }
        guardianIsSaving = false
    }

    @State private var guardianEditedName: String = ""
    @State private var guardianEditedNotes: String = ""
    @State private var guardianIsSaving: Bool = false
    @State private var guardianErrorMessage: String?
    @State private var isCreatingContact: Bool = false
    @State private var createContactError: String?

    @State private var cachedAssistantName: String = AssistantDisplayName.resolve(IdentityInfo.current?.name)

    /// Assistant detail — header + channels.
    @ViewBuilder
    private var assistantDetailView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                // Header matching contact/guardian detail pattern
                HStack(spacing: VSpacing.sm) {
                    Text("\(cachedAssistantName) (Your Assistant)")
                        .font(VFont.titleSmall)
                        .foregroundStyle(VColor.contentDefault)
                    ContactTypeBadge(role: "assistant")
                }
                .padding(.horizontal, VSpacing.lg)

                if let store {
                    AssistantChannelsDetailView(store: store, connectionManager: connectionManager, conversationManager: conversationManager, assistantName: cachedAssistantName, showCardBorders: false)
                        .padding(.horizontal, VSpacing.lg)
                        .padding(.bottom, VSpacing.lg)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .contentMargins(0)
        .task {
            let info = await IdentityInfo.loadAsync()
            cachedAssistantName = AssistantDisplayName.firstUserFacing(from: [info?.name]) ?? AssistantDisplayName.placeholder
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
