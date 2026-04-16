import SwiftUI
import VellumAssistantShared

/// Secure text field for API key entry with automatic placeholder handling.
///
/// Shows masked dots (or a custom masked string) when a key already exists,
/// and an empty-state prompt when no key is stored. Wraps ``VTextField`` with
/// `isSecure: true`.
///
/// Callers can chain standard SwiftUI modifiers (`.disabled()`, `.id()`, etc.)
/// on the returned view as needed.
@MainActor
struct APIKeyTextField: View {
    let label: String
    let hasKey: Bool
    @Binding var text: String
    var maskedPlaceholder: String = "••••••••••••••••"
    var emptyPlaceholder: String = "Enter your API key"
    var errorMessage: String?
    var maxWidth: CGFloat = .infinity

    var body: some View {
        let placeholder = hasKey ? maskedPlaceholder : emptyPlaceholder
        VTextField(
            label,
            placeholder: placeholder,
            text: $text,
            isSecure: true,
            errorMessage: errorMessage,
            maxWidth: maxWidth
        )
    }
}
