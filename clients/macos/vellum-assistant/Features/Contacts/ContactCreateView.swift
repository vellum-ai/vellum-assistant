import SwiftUI
import VellumAssistantShared

/// A form sheet for creating a new contact with a display name
/// and optional notes.
@MainActor
struct ContactCreateView: View {
    var daemonClient: DaemonClient?
    var contactClient: ContactClientProtocol = ContactClient()
    @Binding var isPresented: Bool
    var onCreated: ((ContactPayload) -> Void)?

    // MARK: - Form State

    @State private var displayName = ""
    @State private var notes = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            header
            formFields
            Spacer()
            if let errorMessage {
                VInlineMessage(errorMessage)
            }
            actionButtons
        }
        .padding(VSpacing.xl)
        .frame(width: 400, height: 340)
        .background(VColor.surfaceOverlay)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Add Contact")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.contentDefault)
            Text("Create a new contact with optional notes.")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
        }
    }

    // MARK: - Form Fields

    private var formFields: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Display name (required)
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Display Name")
                    .font(VFont.inputLabel)
                    .foregroundColor(VColor.contentSecondary)
                VTextField(placeholder: "e.g. Alice Chen", text: $displayName)
            }

            // Notes (optional)
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Notes")
                    .font(VFont.inputLabel)
                    .foregroundColor(VColor.contentSecondary)
                ZStack(alignment: .topLeading) {
                    if notes.isEmpty {
                        Text("e.g. Colleague, prefers casual tone (optional)")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentTertiary)
                            .padding(.horizontal, VSpacing.xs)
                            .padding(.vertical, VSpacing.sm)
                    }
                    TextEditor(text: $notes)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentDefault)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 60, maxHeight: 120)
                }
                .padding(VSpacing.xs)
                .background(VColor.surfaceBase)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.borderBase, lineWidth: 1)
                )
            }
        }
    }

    // MARK: - Action Buttons

    private var actionButtons: some View {
        HStack(spacing: VSpacing.md) {
            VButton(label: "Cancel", style: .outlined) {
                isPresented = false
            }
            Spacer()
            VButton(
                label: isSubmitting ? "Creating..." : "Create",
                style: .primary,
                isDisabled: !canSubmit
            ) {
                submit()
            }
        }
    }

    // MARK: - Helpers

    private var canSubmit: Bool {
        !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSubmitting
    }

    private func submit() {
        guard canSubmit else { return }
        isSubmitting = true
        errorMessage = nil

        let trimmedNotes = notes.trimmingCharacters(in: .whitespacesAndNewlines)

        Task {
            do {
                let contact = try await contactClient.createContact(
                    displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines),
                    notes: trimmedNotes.isEmpty ? nil : trimmedNotes,
                    channels: nil
                )
                if let contact {
                    onCreated?(contact)
                    isPresented = false
                } else {
                    errorMessage = "Failed to create contact. Please try again."
                    isSubmitting = false
                }
            } catch {
                errorMessage = error.localizedDescription
                isSubmitting = false
            }
        }
    }
}

// MARK: - Preview

#if DEBUG

private struct ContactCreateViewPreviewWrapper: View {
    @State private var isPresented = true

    var body: some View {
        ZStack {
            VColor.surfaceOverlay.ignoresSafeArea()
            ContactCreateView(
                daemonClient: nil,
                isPresented: $isPresented
            )
        }
    }
}
#endif
