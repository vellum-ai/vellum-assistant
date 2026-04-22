#if canImport(UIKit)
import SwiftUI
import UIKit

/// Decorative "welcome characters" strip for the bottom edge of onboarding
/// screens. Displays the same `welcome-characters.png` asset as macOS so the
/// two platforms read as the same onboarding experience.
///
/// Attach with `.safeAreaInset(edge: .bottom, spacing: 0) { ... }` on the
/// screen's root view. The ZStack wrapper bottom-aligns the image inside
/// its bounds so the characters stay glued to the bottom edge once
/// `.ignoresSafeArea` extends the frame past the home indicator — a plain
/// `Image(.aspectRatio(.fit))` would instead center the art inside the
/// extended frame and leave a visible gap below.
struct OnboardingBottomStrip: View {
    var body: some View {
        ZStack(alignment: .bottom) {
            Image(uiImage: Self.characters ?? UIImage())
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: .infinity)
        }
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
