#if canImport(UIKit)
import SwiftUI
import UIKit

/// Decorative "welcome characters" strip for the bottom edge of onboarding
/// screens. Displays the same `welcome-characters.png` asset as macOS so the
/// two platforms read as the same onboarding experience.
///
/// Attach with `.safeAreaInset(edge: .bottom, spacing: 0) { ... }` on the
/// screen's root view. The image itself ignores the bottom safe area so
/// the characters bleed under the home indicator, matching the Figma design.
struct OnboardingBottomStrip: View {
    var body: some View {
        Image(uiImage: Self.characters ?? UIImage())
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(maxWidth: .infinity)
            .accessibilityHidden(true)
            .ignoresSafeArea(.container, edges: .bottom)
    }

    private static let characters: UIImage? = {
        guard let url = Bundle.main.url(forResource: "welcome-characters", withExtension: "png") else { return nil }
        guard let data = try? Data(contentsOf: url) else { return nil }
        return UIImage(data: data)
    }()
}
#endif
