import SwiftUI
import VellumAssistantShared

/// Single-line hero row at the top of the redesigned Home page.
///
/// A compact avatar followed by an editorial-style greeting in the brand
/// serif. The greeting personalizes on `state.userName` when present and
/// otherwise falls back to a name-less form so the line never reads
/// "… , ?" with a missing token.
struct HomeHeroView: View {
    let state: RelationshipState

    @State private var appearance = AvatarAppearanceManager.shared

    /// Small inline avatar — big enough to read as the assistant's face
    /// next to a 32pt headline, small enough that it doesn't compete with
    /// the greeting for attention.
    private let avatarSize: CGFloat = 44

    var body: some View {
        HStack(alignment: .center, spacing: VSpacing.md) {
            avatarView
            Text(greetingText)
                .font(VFont.brandMedium)
                .foregroundStyle(VColor.contentEmphasized)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private var greetingText: String {
        if let name = state.userName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            return "What are we doing today, \(name)?"
        }
        return "What are we doing today?"
    }

    @ViewBuilder
    private var avatarView: some View {
        if appearance.customAvatarImage != nil {
            VAvatarImage(
                image: appearance.fullAvatarImage,
                size: avatarSize,
                showBorder: false
            )
        } else if let body = appearance.characterBodyShape,
                  let eyes = appearance.characterEyeStyle,
                  let color = appearance.characterColor {
            AnimatedAvatarView(
                bodyShape: body,
                eyeStyle: eyes,
                color: color,
                size: avatarSize,
                entryAnimationEnabled: false
            )
            .frame(width: avatarSize, height: avatarSize)
        } else {
            VAvatarImage(
                image: appearance.fullAvatarImage,
                size: avatarSize,
                showBorder: false
            )
        }
    }
}
