import SpriteKit
import SwiftUI

/// SwiftUI wrapper for the SpriteKit egg hatch scene.
struct EggSceneView: View {
    let state: OnboardingState
    @State private var scene: EggHatchScene = {
        let s = EggHatchScene()
        s.size = CGSize(width: 280, height: 480)
        s.scaleMode = .resizeFill
        s.backgroundColor = .clear
        return s
    }()

    var body: some View {
        SpriteView(scene: scene, options: [.allowsTransparency])
            .onAppear {
                // Set initial crack progress without animation for restored sessions
                let progress = state.crackProgress
                if progress > 0 {
                    scene.setCrackProgress(progress, animated: false)
                }
            }
            .onChange(of: state.crackProgress) { _, newValue in
                scene.setCrackProgress(newValue, animated: true)
            }
            .onChange(of: state.currentStep) { old, new in
                if (3...5).contains(new) && new > old {
                    scene.triggerDramaticCrack(for: new)
                } else if new == 6 {
                    scene.triggerFullHatch()
                }
            }
    }
}
