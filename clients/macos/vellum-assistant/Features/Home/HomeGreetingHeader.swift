import SwiftUI
import VellumAssistantShared

/// Greeting header for the Home feed.
///
/// Displays a caller-provided avatar on the leading edge and a primary
/// "New Chat" pill CTA on the trailing edge. The avatar speaks for itself —
/// the row deliberately carries no headline copy.
///
/// The caller is responsible for sizing the avatar (typical: 40x40pt) and for
/// any outer padding around the header.
struct HomeGreetingHeader<Avatar: View>: View {
    let onStartNewChat: () -> Void
    @ViewBuilder let avatar: () -> Avatar

    var body: some View {
        HStack(alignment: .center, spacing: VSpacing.md) {
            avatar()

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
