import SwiftUI
import VellumAssistantShared

/// Placeholder for the evolving avatar view used during onboarding.
/// The full evolving-monster concept was removed, so this renders the
/// static initial avatar image instead.
struct EvolvingAvatarView: View {
    let evolutionState: AvatarEvolutionState
    var animated: Bool = false

    var body: some View {
        Image("initial-avatar")
            .resizable()
            .interpolation(.none)
            .aspectRatio(contentMode: .fit)
    }
}
