#if canImport(UIKit)
import SwiftUI
import UIKit

/// Decorative "welcome characters" strip for the bottom edge of onboarding
/// screens. Displays the same `welcome-characters.png` asset as macOS so the
/// two platforms read as the same onboarding experience.
///
/// Pair with `.ignoresSafeArea(.container, edges: .bottom)` at the call
/// site so the strip bleeds past the home indicator.
struct OnboardingBottomStrip: View {
    /// Intrinsic height. Exposed so callers can reserve matching space
    /// above the strip without duplicating the literal.
    static let height: CGFloat = 88

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
