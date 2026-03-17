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
    var guardianName: String?

    @State var currentContact: ContactPayload?
    @State private var showDeleteConfirmation = false
    @State private var isDeleting = false
    @State private var actionInProgress: String?
    @State var errorMessage: String?
    @State private var editedName = ""
    @State private var editedNotes = ""
    @FocusState private var isNameFocused: Bool
    @State private var isSaving = false

    var displayContact: ContactPayload {
        currentContact ?? contact
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                headerSection
                    .padding(VSpacing.lg)
                    .vCard(radius: VRadius.lg, background: VColor.surfaceOverlay)

                GuardianChannelsDetailView(
                    contact: displayContact,
                    daemonClient: daemonClient,
                    store: store,
                    onSelectAssistant: onSelectAssistant,
                    showCardBorders: false
                )
                .padding(VSpacing.lg)
                .vCard(radius: VRadius.lg, background: VColor.surfaceOverlay)
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
            currentContact = nil
            let name = contact.displayName
            editedName = (name == "New Contact") ? "" : name
            editedNotes = contact.notes ?? ""
        }
        .onChange(of: contact) { _, _ in
            currentContact = nil
            let name = contact.displayName
            editedName = (name == "New Contact") ? "" : name
            editedNotes = contact.notes ?? ""
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
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
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
                isDisabled: isDeleting || actionInProgress != nil
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
            } else {
                errorMessage = "Failed to save changes"
            }
        } catch {
            errorMessage = "Failed to save: \(error.localizedDescription)"
        }
        isSaving = false
    }

    private func deleteContact() {
        guard actionInProgress == nil else { return }
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

// MARK: - Preview

#Preview {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
        ContactDetailView(
            contact: ContactPayload(
                id: "contact-1",
                displayName: "Alice Smith",
                role: "contact",
                notes: "Colleague, prefers casual tone. Responds within hours.",
                contactType: "human",
                lastInteraction: Date().timeIntervalSince1970 * 1000 - 3_600_000,
                interactionCount: 42,
                channels: [
                    ContactChannelPayload(
                        id: "ch-1",
                        type: "telegram",
                        address: "@alicesmith",
                        isPrimary: true,
                        status: "active",
                        policy: "allow",
                        verifiedAt: Int(Date().timeIntervalSince1970 * 1000) - 86_400_000,
                        verifiedVia: "telegram"
                    ),
                    ContactChannelPayload(
                        id: "ch-2",
                        type: "email",
                        address: "alice@example.com",
                        isPrimary: false,
                        status: "active",
                        policy: "allow"
                    ),
                    ContactChannelPayload(
                        id: "ch-4",
                        type: "slack",
                        address: "#general",
                        isPrimary: false,
                        status: "pending",
                        policy: "restrict",
                        lastSeenAt: Int(Date().timeIntervalSince1970 * 1000) - 7_200_000
                    ),
                    ContactChannelPayload(
                        id: "ch-5",
                        type: "whatsapp",
                        address: "+1555987654",
                        isPrimary: false,
                        status: "unverified",
                        policy: "allow"
                    )
                ]
            )
        )
        .frame(width: 500, height: 700)
    }
    .preferredColorScheme(.dark)
}
