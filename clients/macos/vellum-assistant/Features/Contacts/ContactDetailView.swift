import SwiftUI
import VellumAssistantShared

/// Detail view for a single contact, showing header info (including notes),
/// channels with verification status, and action buttons.
@MainActor
struct ContactDetailView: View {
    let contact: ContactPayload
    var daemonClient: DaemonClient?
    var contactClient: ContactClientProtocol = ContactClient()
    var store: SettingsStore?
    var onDelete: (() -> Void)?
    var onSelectAssistant: (() -> Void)?
    var showToast: ((String, ToastInfo.Style) -> Void)?
    var guardianName: String?

    @State var currentContact: ContactPayload?
    @State private var showDeleteConfirmation = false
    @State private var isDeleting = false
    @State var errorMessage: String?
    @State private var editedName = ""
    @State private var editedNotes = ""
    @FocusState private var isNameFocused: Bool
    @State private var focusTask: Task<Void, Never>?
    @State private var isSaving = false

    var displayContact: ContactPayload {
        currentContact ?? contact
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                headerSection
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.bottom, VSpacing.lg)

                GuardianChannelsDetailView(
                    contact: displayContact,
                    daemonClient: daemonClient,
                    store: store,
                    onSelectAssistant: onSelectAssistant,
                    showCardBorders: false
                )
                .padding(VSpacing.lg)

                if let errorMessage {
                    VInlineMessage(errorMessage)
                }
            }
        }
        .confirmationDialog(
            "Delete \(displayContact.displayName)?",
            isPresented: $showDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                deleteContact()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will permanently delete this contact and all their channels. This action cannot be undone.")
        }
        .onChange(of: contact.id) { _, _ in
            focusTask?.cancel()
            focusTask = nil
            currentContact = nil
            errorMessage = nil
            let name = contact.displayName
            editedName = (name == "New Contact") ? "" : name
            editedNotes = contact.notes ?? ""
        }
        .onChange(of: contact) { _, _ in
            currentContact = nil
            errorMessage = nil
            let name = contact.displayName
            editedName = (name == "New Contact") ? "" : name
            editedNotes = contact.notes ?? ""
        }
        .onDisappear {
            focusTask?.cancel()
            focusTask = nil
        }
    }

    // MARK: - Header Section

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            headerTitle
            headerFields
            headerActions
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear {
            // Leave name empty for placeholder contacts so the placeholder text shows
            let name = displayContact.displayName
            let isNewContact = name == "New Contact"
            editedName = isNewContact ? "" : name
            editedNotes = displayContact.notes ?? ""
            if isNewContact {
                focusTask?.cancel()
                focusTask = Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 300_000_000)
                    guard !Task.isCancelled else { return }
                    isNameFocused = true
                }
            }
        }
    }

    private var headerTitle: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                HStack(spacing: VSpacing.sm) {
                    Text(displayContact.displayName)
                        .font(VFont.display)
                        .foregroundColor(VColor.contentDefault)
                    contactTypeBadge
                }
                Text("\(displayContact.interactionCount) interaction\(displayContact.interactionCount == 1 ? "" : "s")")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }
            Spacer()
            VButton(
                label: "Delete Contact",
                leftIcon: VIcon.trash.rawValue,
                style: .dangerGhost,
                isDisabled: isDeleting
            ) {
                // Skip confirmation for empty/placeholder contacts
                if displayContact.displayName == "New Contact" && displayContact.channels.isEmpty && displayContact.interactionCount == 0 {
                    deleteContact()
                } else {
                    showDeleteConfirmation = true
                }
            }
        }
    }

    private var headerFields: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Name")
                    .font(VFont.inputLabel)
                    .foregroundColor(VColor.contentSecondary)
                VTextField(placeholder: "Give this human a name", text: $editedName)
                    .focused($isNameFocused)
            }

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Notes")
                    .font(VFont.inputLabel)
                    .foregroundColor(VColor.contentSecondary)
                VTextEditor(
                    placeholder: "Optional notes about the human which AI will take into account",
                    text: $editedNotes,
                    minHeight: 80,
                    maxHeight: 180
                )
            }
        }
    }

    private var headerActions: some View {
        HStack(spacing: VSpacing.sm) {
            VButton(label: "Save", style: .primary, isDisabled: isSaving || editedName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                Task { await saveCardEdits() }
            }
            if isSaving {
                ProgressView()
                    .controlSize(.small)
            }
        }
    }

    private var contactTypeBadge: some View {
        ContactTypeBadge(role: displayContact.role)
    }

    // MARK: - Actions

    private func saveCardEdits() async {
        let trimmedName = editedName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { return }
        let trimmedNotes = editedNotes.trimmingCharacters(in: .whitespacesAndNewlines)

        let originalNotes = displayContact.notes ?? ""
        if trimmedName == displayContact.displayName && trimmedNotes == originalNotes {
            return
        }

        isSaving = true
        errorMessage = nil
        do {
            if let updated = try await contactClient.updateContact(
                contactId: displayContact.id,
                displayName: trimmedName,
                notes: trimmedNotes
            ) {
                currentContact = updated
                editedName = updated.displayName
                editedNotes = updated.notes ?? ""
                showToast?("Contact saved", .success)
            } else {
                errorMessage = "Failed to save changes"
                showToast?("Failed to save contact", .error)
            }
        } catch {
            errorMessage = "Failed to save: \(error.localizedDescription)"
            showToast?("Failed to save contact", .error)
        }
        isSaving = false
    }

    private func deleteContact() {
        guard !isDeleting else { return }
        isDeleting = true
        errorMessage = nil

        Task {
            do {
                let success = try await contactClient.deleteContact(contactId: displayContact.id)
                if success {
                    onDelete?()
                } else {
                    errorMessage = "Failed to delete contact"
                }
            } catch {
                errorMessage = "Failed to delete contact: \(error.localizedDescription)"
            }
            isDeleting = false
        }
    }
}
