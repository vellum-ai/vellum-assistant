import SwiftUI
import VellumAssistantShared

/// A reusable card component for displaying a dashboard task.
/// Shows an emoji icon, title, subtitle, and a CTA button that triggers
/// the task's kickoff intent in the chat.
struct DashboardTaskCard: View {
    let task: DashboardTask
    let accentColor: Color?
    let onTap: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text(task.emoji)
                    .font(VFont.cardEmoji)

                Spacer(minLength: VSpacing.xs)

                Text(task.title)
                    .font(VFont.cardTitle)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(2)

                Text(task.subtitle)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                    .lineLimit(2)

                Spacer(minLength: VSpacing.sm)

                HStack {
                    Spacer()
                    Text("Start")
                        .font(VFont.bodyMedium)
                        .foregroundColor(.white)
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.buttonV)
                        .background(accentColor ?? VColor.accent)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                }
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(isHovered ? VColor.surface.opacity(0.9) : VColor.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(isHovered ? (accentColor ?? VColor.accent).opacity(0.4) : VColor.surfaceBorder, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: VRadius.lg))
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            withAnimation(VAnimation.fast) {
                isHovered = hovering
            }
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }
}
