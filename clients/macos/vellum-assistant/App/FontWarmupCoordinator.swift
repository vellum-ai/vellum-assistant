import Foundation
import os
import CoreText
import VellumAssistantShared

/// Coordinates off-main-thread font registration and warmup at app launch.
///
/// Owned by AppDelegate; callers use `awaitReady()` to gate UI creation
/// until fonts are resolved and cached by CoreText.
@MainActor
final class FontWarmupCoordinator {

    static let shared = FontWarmupCoordinator()

    @Published private(set) var isReady = false

    private let logger = Logger(subsystem: Bundle.appBundleIdentifier, category: "fontWarmup")

    /// The detached warmup task — nil until `start()` is called.
    private var warmupTask: Task<Void, Never>?

    /// Continuations parked by `awaitReady()` callers, resumed when warmup completes.
    private var waiters: [CheckedContinuation<Void, Never>] = []

    private init() {}

    // MARK: - Public API

    /// Kicks off font registration and prewarm on a detached (non-main) task.
    ///
    /// Idempotent — subsequent calls after the first are no-ops.
    func start(registerFonts: @Sendable @escaping () -> Void) {
        guard warmupTask == nil else { return }

        logger.info("[fontWarmup] start")

        warmupTask = Task.detached(priority: .userInitiated) { [logger] in
            registerFonts()
            logger.info("[fontWarmup] registerFonts done")

            VFont.prewarmForAppLaunch()
            logger.info("[fontWarmup] prewarm done")

            await MainActor.run {
                self.refreshTypographyStateForReadyFonts()
                self.markReady()
            }
        }
    }

    /// Suspends the caller until font warmup is complete.
    ///
    /// Returns immediately if warmup has already finished.
    func awaitReady() async {
        if isReady {
            logger.info("[fontWarmup] awaitReady: already ready")
            return
        }

        logger.info("[fontWarmup] awaitReady: waiting...")
        let startTime = ContinuousClock.now

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            if isReady {
                continuation.resume()
            } else {
                waiters.append(continuation)
            }
        }

        let elapsed = ContinuousClock.now - startTime
        let ms = elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000
        logger.info("[fontWarmup] awaitReady: resumed after \(ms)ms")
    }

    // MARK: - Private

    func refreshTypographyStateForReadyFonts() {
        VFont.bumpTypographyGeneration()
        MarkdownSegmentView.clearAttributedStringCache()
        MarkdownRenderer.clearCaches()
        ChatBubble.segmentCache.removeAllObjects()
        ChatBubble.lastStreamingSegments = nil
        ChatBubble.lastStreamingParseTime = 0
    }

    private func markReady() {
        isReady = true
        logger.info("[fontWarmup] ready")
        for waiter in waiters {
            waiter.resume()
        }
        waiters.removeAll()
    }
}
