#if canImport(UIKit)
import SwiftUI
import UIKit

/// Decorative "welcome characters" strip for the bottom edge of onboarding
/// screens. Displays the same `welcome-characters.png` asset as macOS so the
/// two platforms read as the same onboarding experience.
///
/// Attach with `.safeAreaInset(edge: .bottom, spacing: 0) { ... }` on the
/// screen's root view.
///
/// ## Layout
///
/// Two SwiftUI modifiers must cooperate here:
/// - `safeAreaInset` is the only modifier that reserves layout space above
///   the bottom edge by shrinking the parent's safe area.
/// - `ignoresSafeArea` is the only modifier that lets a view bleed past the
///   home indicator.
///
/// A single view cannot do both (applying `ignoresSafeArea` to the inset
/// content also cancels the `safeAreaInset` reservation). So the inset
/// content is a `Color.clear` spacer — its height determines how much space
/// is reserved above the home indicator — and the actual art is drawn as a
/// `.background(alignment: .bottom)` that anchors its bottom to the spacer
/// and then extends past the safe area via its own `ignoresSafeArea`.
///
/// Trying the obvious `Image(.resizable().aspectRatio(.fit)).ignoresSafeArea()`
/// fails because `.fit` centers the rendered art inside the extended frame
/// rather than anchoring it to the bottom edge.
struct OnboardingBottomStrip: View {
    /// How much of the strip sits above the home indicator. The remaining
    /// ~34pt of the art bleeds under the indicator via the background's
    /// `ignoresSafeArea`. Tuned for iPhone 17 Pro-class screens; on smaller
    /// iPhones the bleed portion is larger but the visual still reads
    /// correctly.
    private static let visibleHeight: CGFloat = 72

    var body: some View {
        Color.clear
            .frame(height: Self.visibleHeight)
            .frame(maxWidth: .infinity)
            .background(alignment: .bottom) {
                Image(uiImage: Self.characters ?? UIImage())
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    .ignoresSafeArea(.container, edges: .bottom)
            }
            .accessibilityHidden(true)
    }

    private static let characters: UIImage? = {
        guard let url = Bundle.main.url(forResource: "welcome-characters", withExtension: "png") else { return nil }
        guard let data = try? Data(contentsOf: url) else { return nil }
        return UIImage(data: data)
    }()
}
#endif
