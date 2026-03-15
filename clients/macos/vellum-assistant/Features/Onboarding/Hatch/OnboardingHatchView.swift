import SwiftUI

/// Legacy wrapper — the egg hatch is now rendered by EggSceneView in the split layout.
/// This file is kept to avoid breaking any remaining references during transition.
@MainActor
struct OnboardingHatchView: View {
    @Bindable var state: OnboardingState

    var body: some View {
        EggSceneView(state: state)
            .frame(width: 280, height: 480)
    }
}
