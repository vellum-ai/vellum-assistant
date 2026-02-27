import Foundation
import Combine
import CoreGraphics
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "RideShotgunTrigger")

@MainActor
public final class RideShotgunTrigger: ObservableObject {
    @Published public var shouldShowInvitation: Bool = false

    private var checkTimer: Timer?
    private let appLaunchDate = Date()
    private var cancellables = Set<AnyCancellable>()

    /// Tracks whether the app is currently in the foreground; used to skip evaluation
    /// when the user has switched away, preventing background CPU drain.
    private var isAppActive: Bool = true

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

    public init() {
        NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)
            .sink { [weak self] _ in self?.isAppActive = false }
            .store(in: &cancellables)
        NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)
            .sink { [weak self] _ in self?.isAppActive = true }
            .store(in: &cancellables)
    }

    public func start() {
        guard checkTimer == nil else { return }
        // 300s interval: the trigger checks infrequently to avoid background CPU drain.
        checkTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
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
        // Skip when the app is not in the foreground — no point surfacing an invitation
        // the user won't see, and this avoids unnecessary work while backgrounded.
        guard isAppActive else { return }

        // Skip when the display is asleep; there's no one to show the invitation to.
        guard !CGDisplayIsAsleep(CGMainDisplayID()) else { return }

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
