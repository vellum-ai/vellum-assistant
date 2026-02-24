import SwiftUI
import VellumAssistantShared

/// A reusable message bubble for inbox thread messages.
/// User messages are right-aligned with accent background; assistant messages are left-aligned with surface background.
struct InboxMessageBubble: View {
    let role: String
    let content: String
    let timestamp: Date?

    private var isUser: Bool { role == "user" }

    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 0) }

            VStack(alignment: isUser ? .trailing : .leading, spacing: VSpacing.xxs) {
                Text(content)
                    .font(VFont.body)
                    .foregroundColor(isUser ? .white : VColor.textPrimary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.sm)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .fill(isUser ? VColor.accent : VColor.surface)
                    )
                    .frame(maxWidth: 280, alignment: isUser ? .trailing : .leading)

                if let timestamp {
                    Text(formattedTimestamp(timestamp))
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }

            if !isUser { Spacer(minLength: 0) }
        }
    }

    private func formattedTimestamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            formatter.dateFormat = "h:mm a"
        } else {
            formatter.dateFormat = "MMM d, h:mm a"
        }
        return formatter.string(from: date)
    }
}

#Preview("InboxMessageBubble - User") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: VSpacing.md) {
            InboxMessageBubble(
                role: "user",
                content: "Hey, can you help me with something?",
                timestamp: Date()
            )
            InboxMessageBubble(
                role: "assistant",
                content: "Of course! I'd be happy to help. What do you need?",
                timestamp: Date().addingTimeInterval(-60)
            )
            InboxMessageBubble(
                role: "user",
                content: "I need to set up a new project with TypeScript and React.",
                timestamp: Date().addingTimeInterval(-120)
            )
        }
        .padding()
    }
    .frame(width: 400, height: 300)
}
