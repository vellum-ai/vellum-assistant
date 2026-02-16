import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "RideShotgunTrigger")

@MainActor
public final class RideShotgunTrigger: ObservableObject {
    @Published public var shouldShowInvitation: Bool = false

    private var checkTimer: Timer?
    private let appLaunchDate = Date()

    /// Minimum time (minutes) since app launch before offering
    private let minAppRunMinutes: Double = 15

    /// Maximum sessions before we stop auto-offering
    private let maxAutoOfferSessions: Int = 3

    /// Cooldown after decline or completion (hours)
    private let cooldownHours: Double = 24

    // MARK: - UserDefaults keys
    private let totalSessionCountKey = "rideShotgunTotalSessionCount"
    private let lastDeclinedDateKey = "rideShotgunLastDeclinedDate"
    private let lastCompletedDateKey = "rideShotgunLastCompletedDate"

    public init() {}

    public func start() {
        guard checkTimer == nil else { return }
        checkTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            guard let strongSelf = self else { return }
            Task { @MainActor in
                strongSelf.evaluate()
            }
        }
        log.info("Ride shotgun trigger started")
    }

    public func stop() {
        checkTimer?.invalidate()
        checkTimer = nil
        shouldShowInvitation = false
        log.info("Ride shotgun trigger stopped")
    }

    public func recordSessionStarted() {
        let count = UserDefaults.standard.integer(forKey: totalSessionCountKey)
        UserDefaults.standard.set(count + 1, forKey: totalSessionCountKey)
        shouldShowInvitation = false
        log.info("Ride shotgun session started (total: \(count + 1))")
    }

    public func recordDeclined() {
        UserDefaults.standard.set(Date(), forKey: lastDeclinedDateKey)
        shouldShowInvitation = false
        log.info("Ride shotgun invitation declined")
    }

    public func recordCompleted() {
        UserDefaults.standard.set(Date(), forKey: lastCompletedDateKey)
        shouldShowInvitation = false
        log.info("Ride shotgun session completed")
    }

    private func evaluate() {
        // Already showing?
        guard !shouldShowInvitation else { return }

        // App running long enough?
        let minutesSinceLaunch = Date().timeIntervalSince(appLaunchDate) / 60
        guard minutesSinceLaunch >= minAppRunMinutes else { return }

        // Haven't exceeded auto-offer limit?
        let totalSessions = UserDefaults.standard.integer(forKey: totalSessionCountKey)
        guard totalSessions < maxAutoOfferSessions else { return }

        // Cooldown since last decline?
        if let lastDeclined = UserDefaults.standard.object(forKey: lastDeclinedDateKey) as? Date {
            let hoursSinceDecline = Date().timeIntervalSince(lastDeclined) / 3600
            guard hoursSinceDecline >= cooldownHours else { return }
        }

        // Cooldown since last completion?
        if let lastCompleted = UserDefaults.standard.object(forKey: lastCompletedDateKey) as? Date {
            let hoursSinceCompletion = Date().timeIntervalSince(lastCompleted) / 3600
            guard hoursSinceCompletion >= cooldownHours else { return }
        }

        shouldShowInvitation = true
        log.info("Ride shotgun invitation triggered")
    }
}
