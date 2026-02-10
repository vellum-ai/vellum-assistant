import SwiftUI
import Observation

/// Manages the hatch state machine and timing progression.
@Observable
final class HatchViewModel {
    var stage: HatchStage = .idle
    var crackLevel: Int = 0
    var showToast: Bool = false

    var onComplete: (() -> Void)?

    private var timers: [Timer] = []

    func handleEggTap() {
        guard stage == .idle else { return }
        stage = .wobble
        startWobbleProgression()
    }

    func reset() {
        cancelTimers()
        stage = .idle
        crackLevel = 0
        showToast = false
    }

    private func startWobbleProgression() {
        cancelTimers()

        schedule(after: HatchTiming.wobbleCrack1) { [weak self] in
            self?.crackLevel = 1
        }
        schedule(after: HatchTiming.wobbleCrack2) { [weak self] in
            self?.crackLevel = 2
        }
        schedule(after: HatchTiming.wobbleCrack3) { [weak self] in
            self?.crackLevel = 3
        }
        schedule(after: HatchTiming.wobbleToCrack) { [weak self] in
            self?.stage = .crack
            self?.crackLevel = 3
            self?.startCrackToBurst()
        }
    }

    private func startCrackToBurst() {
        schedule(after: HatchTiming.crackToBurst) { [weak self] in
            self?.stage = .burst
            self?.startBurstToReveal()
        }
    }

    private func startBurstToReveal() {
        schedule(after: HatchTiming.burstToReveal) { [weak self] in
            self?.stage = .reveal
            self?.startRevealToast()
        }
    }

    private func startRevealToast() {
        schedule(after: HatchTiming.revealToast) { [weak self] in
            self?.showToast = true
            self?.onComplete?()
        }
    }

    // MARK: - Timer Helpers

    private func schedule(after interval: TimeInterval, action: @escaping () -> Void) {
        let timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { _ in
            DispatchQueue.main.async { action() }
        }
        timers.append(timer)
    }

    private func cancelTimers() {
        timers.forEach { $0.invalidate() }
        timers.removeAll()
    }

    deinit {
        cancelTimers()
    }
}
