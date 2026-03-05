import SwiftUI
import VellumAssistantShared

/// A form sheet for creating a new contact with a display name,
/// optional relationship, and one initial channel (type + address).
@MainActor
struct ContactCreateView: View {
    var daemonClient: DaemonClient?
    @Binding var isPresented: Bool
    var onCreated: ((ContactPayload) -> Void)?

    // MARK: - Form State

    @State private var displayName = ""
    @State private var relationship = ""
    @State private var channelType = "telegram"
    @State private var channelAddress = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    private let channelOptions: [(label: String, value: String)] = [
        (label: "Telegram", value: "telegram"),
        (label: "SMS", value: "sms"),
        (label: "Email", value: "email"),
        (label: "Slack", value: "slack"),
        (label: "Voice", value: "voice"),
    ]

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            header
            formFields
            Spacer()
            if let errorMessage {
                errorBanner(errorMessage)
            }
            actionButtons
        }
        .padding(VSpacing.xl)
        .frame(width: 400, height: 420)
        .background(VColor.background)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Add Contact")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)
            Text("Create a new contact with an optional channel.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
    }

    // MARK: - Form Fields

    private var formFields: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Display name (required)
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Display Name")
                    .font(VFont.inputLabel)
                    .foregroundColor(VColor.textSecondary)
                VTextField(placeholder: "e.g. Alice Chen", text: $displayName)
            }

            // Relationship (optional)
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Relationship")
                    .font(VFont.inputLabel)
                    .foregroundColor(VColor.textSecondary)
                VTextField(placeholder: "e.g. Colleague (optional)", text: $relationship)
            }

            // Channel type picker
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Channel Type")
                    .font(VFont.inputLabel)
                    .foregroundColor(VColor.textSecondary)
                VDropdown(
                    placeholder: "Select channel type",
                    selection: $channelType,
                    options: channelOptions
                )
            }

            // Channel address
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Channel Address")
                    .font(VFont.inputLabel)
                    .foregroundColor(VColor.textSecondary)
                VTextField(placeholder: channelAddressPlaceholder, text: $channelAddress)
            }
        }
    }

    // MARK: - Error Banner

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 12))
                .foregroundColor(VColor.error)
            Text(message)
                .font(VFont.caption)
                .foregroundColor(VColor.error)
                .lineLimit(2)
        }
        .padding(VSpacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(VColor.error.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }

    // MARK: - Action Buttons

    private var actionButtons: some View {
        HStack(spacing: VSpacing.md) {
            VButton(label: "Cancel", style: .tertiary, size: .medium) {
                isPresented = false
            }
            Spacer()
            VButton(
                label: isSubmitting ? "Creating..." : "Create",
                style: .primary,
                size: .medium,
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

    private var channelAddressPlaceholder: String {
        switch channelType {
        case "telegram": return "@username or phone number"
        case "sms", "voice": return "+15551234567"
        case "email": return "user@example.com"
        case "slack": return "#channel or @user"
        default: return "Address"
        }
    }

    private func submit() {
        guard let daemonClient, canSubmit else { return }
        isSubmitting = true
        errorMessage = nil

        let trimmedAddress = channelAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        let channels: [DaemonClient.NewContactChannel]? = trimmedAddress.isEmpty ? nil : [
            DaemonClient.NewContactChannel(
                type: channelType,
                address: trimmedAddress,
                isPrimary: true
            ),
        ]

        let trimmedRelationship = relationship.trimmingCharacters(in: .whitespacesAndNewlines)

        Task {
            do {
                let contact = try await daemonClient.createContact(
                    displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines),
                    relationship: trimmedRelationship.isEmpty ? nil : trimmedRelationship,
                    channels: channels
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
struct ContactCreateView_Preview: PreviewProvider {
    static var previews: some View {
        ContactCreateViewPreviewWrapper()
            .frame(width: 400, height: 420)
            .previewDisplayName("ContactCreateView")
    }
}

private struct ContactCreateViewPreviewWrapper: View {
    @State private var isPresented = true

    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            ContactCreateView(
                daemonClient: nil,
                isPresented: $isPresented
            )
        }
    }
}
#endif
