#if canImport(UIKit)
import SwiftUI
import UIKit

/// Decorative "welcome characters" strip for the bottom edge of onboarding
/// screens. Displays the same `welcome-characters.png` asset as macOS so the
/// two platforms read as the same onboarding experience.
///
/// Intended to be placed as the final child of a root `VStack` whose bottom
/// safe area is ignored (see `OnboardingView`). That parent-level
/// `ignoresSafeArea` is what lets the image's bottom edge sit at the
/// physical screen bottom. Do NOT also apply `ignoresSafeArea` here —
/// doing so would extend this view's own frame by the safe-area amount,
/// and `.aspectRatio(.fit)` would then center the characters inside that
/// taller frame, reintroducing a gap below.
struct OnboardingBottomStrip: View {
    var body: some View {
        Image(uiImage: Self.characters ?? UIImage())
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(maxWidth: .infinity)
            .accessibilityHidden(true)
    }

    private static let characters: UIImage? = {
        guard let url = Bundle.main.url(forResource: "welcome-characters", withExtension: "png") else { return nil }
        guard let data = try? Data(contentsOf: url) else { return nil }
        return UIImage(data: data)
    }()
}
#endif
