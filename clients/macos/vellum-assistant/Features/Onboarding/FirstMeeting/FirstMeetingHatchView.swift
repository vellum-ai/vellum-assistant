import VellumAssistantShared
import SpriteKit
import SwiftUI

@MainActor
struct FirstMeetingHatchView: View {
    @Bindable var state: OnboardingState
    let scene: EggHatchScene

    @State private var hatchTimer: Timer?
    @State private var hasTriggeredDramaticCrack = false
    @State private var hasTriggeredFullHatch = false
    @State private var hatchCompleted = false
    @State private var statusText = "Your velly is hatching..."
    @State private var delegateAdapter: HatchDelegateAdapter?

    var body: some View {
        VStack(spacing: VSpacing.xxl) {
            TypewriterText(
                fullText: statusText,
                speed: 0.05,
                font: VFont.onboardingTitle
            )
            .id(statusText)
        }
        .onAppear {
            setupDelegate()
            startHatchTimer()
        }
        .onDisappear {
            hatchTimer?.invalidate()
            hatchTimer = nil
        }
    }

    // MARK: - Timer-Driven Hatch Sequence

    private func startHatchTimer() {
        // Drive crackProgress from current value to 1.0 over ~8 seconds.
        let startProgress = state.firstMeetingCrackProgress
        let totalDuration: CGFloat = 8.0
        let tickInterval: CGFloat = 0.1
        let progressRange = 1.0 - startProgress
        let increment = progressRange * (tickInterval / totalDuration)

        hatchTimer = Timer.scheduledTimer(withTimeInterval: tickInterval, repeats: true) { _ in
            Task { @MainActor in
                guard !hasTriggeredFullHatch else {
                    hatchTimer?.invalidate()
                    hatchTimer = nil
                    return
                }

                let newProgress = min(state.firstMeetingCrackProgress + increment, 1.0)
                state.firstMeetingCrackProgress = newProgress
                scene.setCrackProgress(newProgress, animated: true)

                // At ~0.5 progress, trigger dramatic crack effects
                if newProgress >= 0.5 && !hasTriggeredDramaticCrack {
                    hasTriggeredDramaticCrack = true
                    scene.triggerDramaticCrack(for: 3)
                }

                // At 1.0 progress, trigger full hatch
                if newProgress >= 1.0 && !hasTriggeredFullHatch {
                    hasTriggeredFullHatch = true
                    hatchTimer?.invalidate()
                    hatchTimer = nil
                    scene.triggerFullHatch()
                }
            }
        }
    }

    // MARK: - Delegate

    private func setupDelegate() {
        let adapter = HatchDelegateAdapter { event in
            Task { @MainActor in
                if event == .fullHatchDone {
                    hatchCompleted = true
                    statusText = "Say hello!"
                    // Wait a moment then auto-advance to step 2
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                        state.advance()
                    }
                }
            }
        }
        delegateAdapter = adapter
        scene.hatchDelegate = adapter
    }
}

/// Bridges the EggHatchSceneDelegate protocol to a closure for use in SwiftUI.
private final class HatchDelegateAdapter: EggHatchSceneDelegate {
    let handler: @Sendable (HatchEvent) -> Void

    init(handler: @escaping @Sendable (HatchEvent) -> Void) {
        self.handler = handler
    }

    func sceneDidComplete(_ event: HatchEvent) {
        handler(event)
    }
}
