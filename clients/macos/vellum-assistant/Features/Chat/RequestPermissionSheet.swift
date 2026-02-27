import SwiftUI
import VellumAssistantShared

// MARK: - Request Permission Sheet

/// Modal sheet that lets a child-profile user describe why they need a blocked
/// tool and choose "Request Once" or "Request Always" to create a parent-approval
/// request via the daemon.
struct BlockedToolPermissionSheet: View {
    /// Pre-populated tool name inferred from the blocked tool call.
    let toolName: String
    /// Called when the user submits the request.  Receives `(toolName, reason, scope)`.
    let onSubmit: (String, String) -> Void
    let onCancel: () -> Void

    @State private var reason: String = ""
    @State private var isSending: Bool = false

    private var canSubmit: Bool {
        !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending
    }

    private var friendlyToolName: String {
        switch toolName {
        case "bash", "host_bash":          return "Terminal (bash)"
        case "browser":                    return "Web browser"
        case "file_read", "host_file_read": return "File read"
        case "file_write", "host_file_write": return "File write"
        case "computer":                   return "Computer control"
        default:                           return toolName
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Title
            Text("Request Parent Permission")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            // Blocked tool pill
            HStack(spacing: VSpacing.xs) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 11))
                    .foregroundColor(VColor.warning)
                Text(friendlyToolName)
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.textSecondary)
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.xs)
            .background(Capsule().fill(VColor.surface))
            .overlay(Capsule().stroke(VColor.warning.opacity(0.4), lineWidth: 0.5))

            // Reason field
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Why do you need this?")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)
                Text("Your parent will see this message.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)

                TextEditor(text: $reason)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .scrollContentBackground(.hidden)
                    .padding(VSpacing.sm)
                    .background(VColor.backgroundSubtle)
                    .cornerRadius(VRadius.md)
                    .frame(height: 100)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
            }

            // Buttons
            HStack(spacing: VSpacing.sm) {
                Button("Cancel") {
                    onCancel()
                }
                .buttonStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)

                Spacer()

                VButton(label: isSending ? "Sending…" : "Send Request", style: .primary) {
                    guard canSubmit else { return }
                    isSending = true
                    let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
                    onSubmit(toolName, trimmed)
                }
                .disabled(!canSubmit)
                .accessibilityLabel("Send permission request to parent")
            }
        }
        .padding(VSpacing.xl)
        .frame(width: 400)
        .background(VColor.background)
    }
}

// MARK: - Preview

#Preview("Blocked Tool Permission Sheet") {
    ZStack {
        VColor.background.ignoresSafeArea()
        BlockedToolPermissionSheet(
            toolName: "bash",
            onSubmit: { _, _ in },
            onCancel: {}
        )
    }
}
