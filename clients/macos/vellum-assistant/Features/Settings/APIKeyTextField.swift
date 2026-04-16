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
    /// Label displayed above the text field (e.g. "API Key", "Anthropic API Key").
    let label: String

    /// Whether the provider already has a stored key. When `true`, the field
    /// shows `maskedPlaceholder`; when `false`, it shows `emptyPlaceholder`.
    let hasKey: Bool

    /// Bound text for the key input.
    @Binding var text: String

    /// Placeholder shown when a key already exists. Defaults to generic masked dots.
    var maskedPlaceholder: String = "••••••••••••••••"

    /// Placeholder shown when no key is stored. Defaults to "Enter your API key".
    var emptyPlaceholder: String = "Enter your API key"

    /// Optional error message displayed below the field.
    var errorMessage: String?

    /// Maximum width for the field. Defaults to `.infinity` (VTextField default).
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
