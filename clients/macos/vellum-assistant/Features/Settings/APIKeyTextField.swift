import SwiftUI
import VellumAssistantShared

/// Secure text field for API key entry with automatic placeholder handling.
///
/// Shows masked dots (or a custom masked string) when a key already exists,
/// and an empty-state prompt when no key is stored. Wraps ``VTextField`` with
/// `isSecure: true`.
///
/// ## Focus handling
/// Requires a `FocusState<Bool>.Binding` so callers can programmatically blur
/// the field after a successful save. Every API key field has an associated
/// save action, so focus control is always needed — this is intentionally
/// non-optional (unlike ``VTextField``'s dual-init pattern).
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
    private var isFocused: FocusState<Bool>.Binding

    init(
        label: String,
        hasKey: Bool,
        text: Binding<String>,
        maskedPlaceholder: String = "••••••••••••••••",
        emptyPlaceholder: String = "Enter your API key",
        errorMessage: String? = nil,
        maxWidth: CGFloat = .infinity,
        isFocused: FocusState<Bool>.Binding
    ) {
        self.label = label
        self.hasKey = hasKey
        self._text = text
        self.maskedPlaceholder = maskedPlaceholder
        self.emptyPlaceholder = emptyPlaceholder
        self.errorMessage = errorMessage
        self.maxWidth = maxWidth
        self.isFocused = isFocused
    }

    var body: some View {
        let placeholder = hasKey ? maskedPlaceholder : emptyPlaceholder
        VTextField(
            label,
            placeholder: placeholder,
            text: $text,
            isSecure: true,
            errorMessage: errorMessage,
            maxWidth: maxWidth,
            isFocused: isFocused
        )
    }
}
