import SwiftUI
import VellumAssistantShared

/// A badge pill showing a contact's classification (Guardian, Assistant, Human)
/// with a distinguishing icon. Styled to match VBadge neutral/subtle appearance.
struct ContactTypeBadge: View {
    let role: String?

    var body: some View {
        HStack(spacing: VSpacing.xxs) {
            VIconView(icon, size: 12)
                .foregroundColor(VColor.primaryBase)
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.contentSecondary)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xxs)
        .background(VColor.surfaceBase)
        .overlay(
            Capsule()
                .stroke(VColor.borderBase.opacity(0.55), lineWidth: 1)
        )
        .clipShape(Capsule())
        .accessibilityLabel(label)
    }

    private var label: String {
        switch role {
        case "guardian": return "Guardian"
        case "assistant": return "Assistant"
        default: return "Human"
        }
    }

    private var icon: VIcon {
        switch role {
        case "guardian": return .shieldCheck
        case "assistant": return .sparkles
        default: return .user
        }
    }
}
