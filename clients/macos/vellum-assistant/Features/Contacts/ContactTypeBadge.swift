import SwiftUI
import VellumAssistantShared

/// A tag showing a contact's classification (Guardian, Assistant, Human)
/// with a distinguishing icon. Thin wrapper around VTag.
struct ContactTypeBadge: View {
    let role: String?

    var body: some View {
        VTag(label, color: VColor.primaryBase, icon: icon)
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
