import SwiftUI
import VellumAssistantShared

/// Destructive-confirmation sheet for the user-initiated account deletion flow.
///
/// On confirm, calls `AuthService.requestAccountDeletion()`, which posts
/// directly to platform at `/v1/user/deletion-request/` (bypassing the local
/// gateway, since deletion is a user-level concern that is not
/// assistant-scoped). Successful deletion only destroys the Vellum cloud
/// account — local assistants on disk are left in place — and is treated as a
/// sign-out from this client's perspective.
@MainActor
struct DeleteAccountConfirmView: View {
    /// Result reported back to the parent so it can dismiss the sheet and
    /// run the standard logout sequence.
    enum Outcome {
        case deleted
    }

    var onDeleted: (Outcome) -> Void
    var onCancel: () -> Void

    /// Injection point for tests. Production callers leave this as the default
    /// closure that calls `AuthService.shared.requestAccountDeletion()`.
    var requestAccountDeletion: () async throws -> AuthService.AccountDeletionStatus = {
        try await AuthService.shared.requestAccountDeletion()
    }

    @State private var isSubmitting: Bool = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            VStack(spacing: VSpacing.md) {
                Text("Delete Vellum Account")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentDefault)

                Text("This permanently deletes your Vellum cloud account and all data stored on Vellum. It cannot be undone.")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
                    .multilineTextAlignment(.center)

                Text("Local assistants on this Mac are not affected — remove them separately if you want them gone.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .multilineTextAlignment(.center)

                if let errorMessage {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.triangleAlert, size: 12)
                            .foregroundStyle(VColor.systemNegativeHover)
                        Text(errorMessage)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.systemNegativeStrong)
                            .multilineTextAlignment(.leading)
                    }
                    .accessibilityElement(children: .combine)
                }
            }

            HStack(spacing: VSpacing.md) {
                VButton(label: "Cancel", style: .outlined, isDisabled: isSubmitting) {
                    onCancel()
                }

                if isSubmitting {
                    HStack(spacing: VSpacing.sm) {
                        ProgressView()
                            .controlSize(.small)
                            .progressViewStyle(.circular)
                        Text("Deleting...")
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentSecondary)
                    }
                } else {
                    VButton(label: "Delete Vellum account", style: .danger) {
                        Task { _ = await submit() }
                    }
                    .accessibilityLabel("Delete Vellum account")
                }
            }
        }
        .padding(VSpacing.xl)
        .frame(width: 360)
        .background(VColor.surfaceOverlay)
    }

    /// Drives the deletion request and updates inline state. Returns the
    /// inline error string set on this submission (or `nil` on success) so
    /// tests can assert the failure copy without reaching into `@State`.
    @discardableResult
    func submit() async -> String? {
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        do {
            switch try await requestAccountDeletion() {
            case .requested:
                onDeleted(.deleted)
                return nil
            case .unavailable:
                let message = "Account deletion is not available for this account."
                errorMessage = message
                return message
            }
        } catch {
            let message = "Could not delete your account: \(error.localizedDescription)"
            errorMessage = message
            return message
        }
    }
}
