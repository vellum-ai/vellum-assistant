import SwiftUI

/// Greeting header for the Home feed.
///
/// Displays a caller-provided avatar, a greeting title (e.g. "Here's what's
/// been going on"), and a primary "New Chat" pill CTA on the trailing edge.
///
/// The caller is responsible for sizing the avatar (typical: 40x40pt) and for
/// any outer padding around the header.
struct HomeGreetingHeader<Avatar: View>: View {
    let greeting: String
    let onStartNewChat: () -> Void
    @ViewBuilder let avatar: () -> Avatar

    var body: some View {
        HStack(alignment: .center, spacing: VSpacing.md) {
            avatar()

            Text(greeting)
                .font(VFont.titleLarge)
                .foregroundStyle(VColor.contentEmphasized)
                .lineLimit(1)

            Spacer()

            // `leftIcon` is the VButton API for a leading icon (there is no
            // `iconLeft`). `VIcon.squarePen` is the codebase's existing token
            // for the "pen-to-square" / new conversation glyph.
            VButton(
                label: "New Chat",
                leftIcon: VIcon.squarePen.rawValue,
                style: .primary,
                size: .pillRegular,
                action: onStartNewChat
            )
        }
    }
}
