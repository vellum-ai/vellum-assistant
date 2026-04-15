import SwiftUI
import VellumAssistantShared

/// Inline chat input used at the top of the redesigned Home page.
///
/// Deliberately lightweight — this is *not* the full ``ComposerView`` that
/// drives active conversations. Home is the "cold start" surface: a user
/// types a prompt, hits Return (or the send button), and the parent
/// opens a fresh conversation pre-seeded with the message. Anything more
/// than that — attachments, slash commands, voice — belongs in the
/// conversation view, not here.
///
/// Submission is gated on a non-whitespace `text` and fires exactly once
/// per Return / button tap; the field is cleared synchronously so the
/// user can immediately queue a second message if they want to. The
/// parent owns navigation (which conversation, which pane) via
/// `onSubmit`.
struct HomeInlineComposer: View {
    let onSubmit: (String) -> Void

    @State private var text: String = ""
    @FocusState private var focused: Bool

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSubmit: Bool { !trimmed.isEmpty }

    var body: some View {
        HStack(alignment: .center, spacing: VSpacing.sm) {
            TextField(
                "",
                text: $text,
                prompt: Text("What would you like to do?")
                    .foregroundStyle(VColor.contentTertiary)
            )
            .textFieldStyle(.plain)
            .font(VFont.bodyLargeDefault)
            .foregroundStyle(VColor.contentEmphasized)
            .focused($focused)
            .onSubmit(submit)
            .accessibilityLabel(Text("New message"))

            sendButton
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VRadius.window, style: .continuous)
                .fill(VColor.surfaceLift)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.window, style: .continuous)
                .stroke(focused ? VColor.contentEmphasized.opacity(0.25) : VColor.borderBase, lineWidth: 1)
        )
        .animation(.easeOut(duration: 0.15), value: focused)
        .contentShape(Rectangle())
        .onTapGesture { focused = true }
    }

    private var sendButton: some View {
        Button(action: submit) {
            ZStack {
                Circle()
                    .fill(canSubmit ? VColor.contentEmphasized : VColor.contentTertiary.opacity(0.35))
                VIconView(.arrowUp, size: 14)
                    .foregroundStyle(VColor.surfaceBase)
            }
            .frame(width: 28, height: 28)
        }
        .buttonStyle(.plain)
        .disabled(!canSubmit)
        .accessibilityLabel(Text("Send"))
        .accessibilityHint(Text("Starts a new conversation with this message"))
    }

    private func submit() {
        let message = trimmed
        guard !message.isEmpty else { return }
        text = ""
        onSubmit(message)
    }
}
