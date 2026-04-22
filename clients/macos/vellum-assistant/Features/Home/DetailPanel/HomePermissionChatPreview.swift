import SwiftUI
import VellumAssistantShared

/// Pure body content for the Home detail side panel's permission-request
/// variant — shown when the assistant is blocked on a tool-confirmation
/// prompt from an active chat. Figma: node `3596:79507` (New App).
///
/// Renders a snapshot of the conversation state at the point the
/// permission request landed:
///
///   1. the last user message that triggered the request
///   2. the assistant's preamble reply explaining what it's about to do
///   3. the live ``ToolConfirmationBubble`` itself, so the user can
///      approve or deny right from the detail panel without jumping
///      back into the conversation
///
/// The "Go to Thread" button lives in the enclosing ``HomeDetailPanel``
/// chrome — this component is pure body content. Visual language
/// matches the in-chat bubbles by reusing ``MessageBubbleView`` with
/// stub closures for the non-relevant affordances (regenerate, fork,
/// surfaces, retry, etc. are all no-ops in a detail-panel context).
struct HomePermissionChatPreview: View {
    @Environment(AssistantFeatureFlagStore.self) private var assistantFeatureFlagStore

    let userMessage: String
    let assistantResponse: String
    let confirmation: ToolConfirmationData
    let onAllow: () -> Void
    let onDeny: () -> Void
    let onAlwaysAllow: (String, String, String, String) -> Void
    var onTemporaryAllow: ((String, String) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            MessageBubbleView(
                message: ChatMessage(role: .user, text: userMessage),
                onConfirmationResponse: nil,
                onSurfaceAction: nil,
                onRegenerate: nil
            )

            MessageBubbleView(
                message: ChatMessage(role: .assistant, text: assistantResponse),
                onConfirmationResponse: nil,
                onSurfaceAction: nil,
                onRegenerate: nil
            )

            // Render the confirmation bubble directly (rather than
            // wrapping it in a MessageBubbleView with .confirmation
            // attached) so the panel owns the callback wiring without
            // the extra machinery of MessageBubbleView's confirmation
            // branch (guardian, surfaces, retry, etc.).
            ToolConfirmationBubble(
                confirmation: confirmation,
                isV3: assistantFeatureFlagStore.isEnabled("permission-controls-v3"),
                onAllow: onAllow,
                onDeny: onDeny,
                onAlwaysAllow: onAlwaysAllow,
                onTemporaryAllow: onTemporaryAllow
            )
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
