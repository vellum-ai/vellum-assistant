import SwiftUI
import VellumAssistantShared

/// A tag showing a contact's classification (Guardian, Assistant, Human)
/// with a distinguishing icon. Thin wrapper around VTag.
struct ContactTypeBadge: View {
    /// Closed set of display variants the badge can render.
    enum Kind {
        case guardian
        case assistant
        case human
    }

    let kind: Kind

    init(kind: Kind) {
        self.kind = kind
    }

    /// Derives the badge kind from a contact's `role` and `contactType` fields.
    /// `role == "guardian"` takes precedence; otherwise `contactType == "assistant"`
    /// selects the assistant variant, and anything else falls back to human.
    init(role: String?, contactType: String?) {
        if role == "guardian" {
            self.kind = .guardian
        } else if contactType == "assistant" {
            self.kind = .assistant
        } else {
            self.kind = .human
        }
    }

    var body: some View {
        VTag(label, color: VColor.primaryBase, icon: icon)
    }

    private var label: String {
        switch kind {
        case .guardian: return "Guardian"
        case .assistant: return "Assistant"
        case .human: return "Human"
        }
    }

    private var icon: VIcon {
        switch kind {
        case .guardian: return .shieldCheck
        case .assistant: return .sparkles
        case .human: return .user
        }
    }
}
