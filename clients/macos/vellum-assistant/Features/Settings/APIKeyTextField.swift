import SwiftUI
import VellumAssistantShared

/// Reusable secure text field for API key entry across settings cards.
///
/// Encapsulates the shared placeholder convention: when a key already exists,
/// the field shows masked dots (or a custom masked string); when no key is
/// stored, it shows an empty-state placeholder (defaults to "Enter your API
/// key"). This eliminates the duplicated placeholder logic that previously
/// lived in each service card and prevents inconsistencies (e.g. forgetting
/// to check `hasKey` before choosing the placeholder).
///
/// Callers can still chain standard SwiftUI modifiers (`.disabled()`, `.id()`,
/// etc.) on the returned view as needed.
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
