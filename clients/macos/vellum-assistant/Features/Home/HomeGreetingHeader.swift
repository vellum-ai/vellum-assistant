import SwiftUI
import VellumAssistantShared

/// Greeting header for the Home feed.
///
/// Displays a caller-provided avatar on the leading edge and an optional
/// display name next to it, with a primary "New Chat" pill CTA on the
/// trailing edge.
///
/// The caller is responsible for sizing the avatar and for any outer padding
/// around the header.
struct HomeGreetingHeader<Avatar: View>: View {
    let onStartNewChat: () -> Void
    let name: String?
    @ViewBuilder let avatar: () -> Avatar

    var body: some View {
        HStack(alignment: .center, spacing: VSpacing.md) {
            avatar()

            if let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines),
               !trimmed.isEmpty {
                Text(trimmed)
                    .font(VFont.titleLarge)
                    .foregroundStyle(VColor.contentEmphasized)
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
}
