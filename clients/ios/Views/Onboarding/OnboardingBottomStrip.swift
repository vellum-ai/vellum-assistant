#if canImport(UIKit)
import SwiftUI
import UIKit

/// Decorative "welcome characters" strip for the bottom edge of onboarding
/// screens. Displays the same `welcome-characters.png` asset as macOS so the
/// two platforms read as the same onboarding experience.
///
/// Attach with `.safeAreaInset(edge: .bottom, spacing: 0) { ... }` on the
/// screen's root view so the strip bleeds past the home indicator and
/// pushes surrounding content up to avoid overlap.
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
