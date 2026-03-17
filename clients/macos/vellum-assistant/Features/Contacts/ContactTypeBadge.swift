import SwiftUI
import VellumAssistantShared

/// A badge pill showing a contact's classification (Guardian, Assistant, Human)
/// with a distinguishing icon. Thin wrapper around VBadge.
struct ContactTypeBadge: View {
    let role: String?

    var body: some View {
        VBadge(label: label, icon: icon, iconColor: VColor.primaryBase, tone: .neutral)
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
