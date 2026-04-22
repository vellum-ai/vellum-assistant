#if canImport(UIKit)
import SwiftUI
import UIKit

/// Decorative "welcome characters" strip for the bottom edge of onboarding
/// screens. Displays the same `welcome-characters.png` asset as macOS so the
/// two platforms read as the same onboarding experience.
///
/// Intended to be placed as the final child of a root `VStack` whose bottom
/// safe area is ignored (see `OnboardingView`). The image then anchors to
/// the physical screen bottom and bleeds past the home indicator, matching
/// the Figma design.
struct OnboardingBottomStrip: View {
    var body: some View {
        Image(uiImage: Self.characters ?? UIImage())
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(maxWidth: .infinity)
            // DEBUG: red outline shows exactly where this view's frame sits.
            // The image content is centered inside this frame when
            // .aspectRatio(.fit) has more space than it needs.
            // Remove before shipping.
            .background(Color.red.opacity(0.35))
            .border(Color.blue, width: 2)
            .accessibilityHidden(true)
    }

    private static let characters: UIImage? = {
        guard let url = Bundle.main.url(forResource: "welcome-characters", withExtension: "png") else { return nil }
        guard let data = try? Data(contentsOf: url) else { return nil }
        return UIImage(data: data)
    }()
}
#endif
