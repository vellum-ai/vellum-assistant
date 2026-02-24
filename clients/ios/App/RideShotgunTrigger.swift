#if canImport(UIKit)
import Foundation
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "RideShotgunTrigger")

/// Timer-based trigger that periodically checks whether to offer the Ride Shotgun
/// invitation. Logic is identical to the macOS counterpart — cooldown periods and
/// session limits are stored in UserDefaults so they persist across launches.
@MainActor
final class RideShotgunTrigger: ObservableObject {
    @Published var shouldShowInvitation: Bool = false

    private var checkTimer: Timer?
    private let appLaunchDate = Date()

    // Minimum time (minutes) since app launch before offering.
    private let minAppRunMinutes: Double = 15

    // Maximum auto-offer sessions before we stop prompting.
    private let maxAutoOfferSessions: Int = 3

    // Cooldown after decline or completion (hours).
    private let cooldownHours: Double = 24

    // MARK: - UserDefaults keys

    private let totalSessionCountKey = "rideShotgunTotalSessionCount"
    private let lastDeclinedDateKey = "rideShotgunLastDeclinedDate"
    private let lastCompletedDateKey = "rideShotgunLastCompletedDate"

    init() {}

    func start() {
        guard checkTimer == nil else { return }
        checkTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                self.evaluate()
            }
        }
        log.info("Ride shotgun trigger started")
    }

    func stop() {
        checkTimer?.invalidate()
        checkTimer = nil
        shouldShowInvitation = false
        log.info("Ride shotgun trigger stopped")
    }

    func recordSessionStarted() {
        let count = UserDefaults.standard.integer(forKey: totalSessionCountKey)
        UserDefaults.standard.set(count + 1, forKey: totalSessionCountKey)
        shouldShowInvitation = false
        log.info("Ride shotgun session started (total: \(count + 1))")
    }

    func recordDeclined() {
        UserDefaults.standard.set(Date(), forKey: lastDeclinedDateKey)
        shouldShowInvitation = false
        log.info("Ride shotgun invitation declined")
    }

    func recordCompleted() {
        UserDefaults.standard.set(Date(), forKey: lastCompletedDateKey)
        shouldShowInvitation = false
        log.info("Ride shotgun session completed")
    }

    // MARK: - Evaluation

    private func evaluate() {
        guard !shouldShowInvitation else { return }

        let minutesSinceLaunch = Date().timeIntervalSince(appLaunchDate) / 60
        guard minutesSinceLaunch >= minAppRunMinutes else { return }

        let totalSessions = UserDefaults.standard.integer(forKey: totalSessionCountKey)
        guard totalSessions < maxAutoOfferSessions else { return }

        if let lastDeclined = UserDefaults.standard.object(forKey: lastDeclinedDateKey) as? Date {
            let hoursSinceDecline = Date().timeIntervalSince(lastDeclined) / 3600
            guard hoursSinceDecline >= cooldownHours else { return }
        }

        if let lastCompleted = UserDefaults.standard.object(forKey: lastCompletedDateKey) as? Date {
            let hoursSinceCompletion = Date().timeIntervalSince(lastCompleted) / 3600
            guard hoursSinceCompletion >= cooldownHours else { return }
        }

        shouldShowInvitation = true
        log.info("Ride shotgun invitation triggered")
    }
}
#endif
