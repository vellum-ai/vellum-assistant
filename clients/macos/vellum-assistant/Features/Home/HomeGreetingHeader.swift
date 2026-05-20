import SwiftUI
import VellumAssistantShared

/// Greeting header for the Home feed.
///
/// Displays a caller-provided avatar on the leading edge, a greeting or
/// display name next to it, and a primary "New Chat" pill CTA on the
/// trailing edge.
///
/// When a personalized `greeting` is available (daemon-generated in the
/// assistant's tone/persona), it takes precedence over the plain `name`.
/// The caller is responsible for sizing the avatar and for any outer padding
/// around the header.
struct HomeGreetingHeader<Avatar: View>: View {
    let onStartNewChat: () -> Void
    let greeting: String?
    let name: String?
    @ViewBuilder let avatar: () -> Avatar

    var body: some View {
        HStack(alignment: .center, spacing: VSpacing.md) {
            avatar()

            if let headline = effectiveHeadline {
                Text(headline)
                    .font(VFont.titleLarge)
                    .foregroundStyle(VColor.contentEmphasized)
                    .lineLimit(2)
            }

            Spacer()

            VButton(
                label: "New Chat",
                leftIcon: VIcon.squarePen.rawValue,
                style: .primary,
                size: .pillRegular,
                action: onStartNewChat
            )
        }
    }

    /// Personalized greeting takes precedence; falls back to the
    /// assistant's display name.
    private var effectiveHeadline: String? {
        if let g = greeting?.trimmingCharacters(in: .whitespacesAndNewlines),
           !g.isEmpty {
            return g
        }
        if let n = name?.trimmingCharacters(in: .whitespacesAndNewlines),
           !n.isEmpty {
            return n
        }
        return nil
    }
}
