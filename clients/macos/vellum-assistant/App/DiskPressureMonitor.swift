import AppKit
import Foundation
import Observation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "DiskPressureMonitor")

struct DiskPressureAlert: Equatable, Sendable {
    let id: String
    let assistantId: String
    let displayPercent: Int
}

@MainActor
@Observable
final class DiskPressureMonitor {
    typealias UsageFractionFetcher = @Sendable () -> Double?
    typealias ActiveAssistantIdProvider = @MainActor () -> String?

    static let triggerUsageFraction = 0.85
    /// Keep the banner visible until usage drops comfortably below the trigger.
    static let resolveUsageFraction = 0.80

    private let fetchUsageFraction: UsageFractionFetcher
    private let activeAssistantIdProvider: ActiveAssistantIdProvider
    private let notificationCenter: NotificationCenter
    private let cadenceNanoseconds: UInt64

    private(set) var alert: DiskPressureAlert?

    @ObservationIgnored private var activeAssistantId: String?
    @ObservationIgnored private var alertCycle = 0
    @ObservationIgnored private var started = false
    @ObservationIgnored private var cadenceTask: Task<Void, Never>?
    @ObservationIgnored private var appActivationObserver: NSObjectProtocol?
    @ObservationIgnored private var activeAssistantObserver: NSObjectProtocol?

    init(
        fetchUsageFraction: @escaping UsageFractionFetcher = { DiskPressureMonitor.defaultUsageFraction() },
        activeAssistantIdProvider: @escaping ActiveAssistantIdProvider = {
            LockfileAssistant.loadActiveAssistantId()
        },
        notificationCenter: NotificationCenter = .default,
        cadenceNanoseconds: UInt64 = 60_000_000_000
    ) {
        self.fetchUsageFraction = fetchUsageFraction
        self.activeAssistantIdProvider = activeAssistantIdProvider
        self.notificationCenter = notificationCenter
        self.cadenceNanoseconds = cadenceNanoseconds
        self.activeAssistantId = activeAssistantIdProvider()
    }

    deinit {
        cadenceTask?.cancel()
        if let appActivationObserver {
            notificationCenter.removeObserver(appActivationObserver)
        }
        if let activeAssistantObserver {
            notificationCenter.removeObserver(activeAssistantObserver)
        }
    }

    func start() {
        guard !started else { return }
        started = true

        appActivationObserver = notificationCenter.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.refreshForCurrentAssistant()
            }
        }

        activeAssistantObserver = notificationCenter.addObserver(
            forName: LockfileAssistant.activeAssistantDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.refreshForCurrentAssistant()
            }
        }

        let cadenceNanoseconds = self.cadenceNanoseconds
        cadenceTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: cadenceNanoseconds)
                guard let self, !Task.isCancelled else { break }
                self.refreshForCurrentAssistant()
            }
        }

        refreshForCurrentAssistant()
    }

    func stop() {
        started = false
        cadenceTask?.cancel()
        cadenceTask = nil
        clearAlert()

        if let appActivationObserver {
            notificationCenter.removeObserver(appActivationObserver)
            self.appActivationObserver = nil
        }
        if let activeAssistantObserver {
            notificationCenter.removeObserver(activeAssistantObserver)
            self.activeAssistantObserver = nil
        }
    }

    func refreshForCurrentAssistant() {
        let assistantId = activeAssistantIdProvider()
        applyUsageFraction(fetchUsageFraction(), assistantId: assistantId)
    }

    func applyUsageFraction(_ usageFraction: Double?, assistantId: String?) {
        updateActiveAssistant(assistantId)

        guard let assistantId, let usageFraction, usageFraction.isFinite else {
            clearAlert()
            return
        }

        if alert == nil {
            guard usageFraction >= Self.triggerUsageFraction else { return }
            alertCycle += 1
        } else if usageFraction < Self.resolveUsageFraction {
            clearAlert()
            return
        }

        let nextAlert = DiskPressureAlert(
            id: Self.alertId(assistantId: assistantId, cycle: alertCycle),
            assistantId: assistantId,
            displayPercent: Self.displayPercent(forUsageFraction: usageFraction)
        )
        if alert != nextAlert {
            alert = nextAlert
        }
    }

    private func updateActiveAssistant(_ assistantId: String?) {
        guard activeAssistantId != assistantId else { return }
        activeAssistantId = assistantId
        clearAlert()
    }

    private func clearAlert() {
        guard alert != nil else { return }
        alert = nil
    }

    /// Reads the home volume's usage fraction using
    /// `volumeAvailableCapacityForImportantUsageKey`, the Apple-recommended
    /// signal that matches what System Settings → Storage and Finder show.
    /// Accounts for purgeable space (Time Machine local snapshots, evictable
    /// iCloud cache) that macOS reclaims under pressure, so the banner agrees
    /// with the user's perceived free space rather than the strict raw-FS
    /// reading from `statfs(2)`.
    nonisolated static func defaultUsageFraction() -> Double? {
        let url = VellumPaths.current.homeDirectory
        guard let values = try? url.resourceValues(forKeys: [
            .volumeTotalCapacityKey,
            .volumeAvailableCapacityForImportantUsageKey,
        ]),
              let total = values.volumeTotalCapacity,
              total > 0,
              let importantAvailable = values.volumeAvailableCapacityForImportantUsage
        else {
            log.debug("Disk-pressure: failed to read volume capacity for home directory")
            return nil
        }
        let totalBytes = Double(total)
        let availableBytes = Double(importantAvailable)
        guard totalBytes.isFinite, availableBytes.isFinite, totalBytes > 0 else { return nil }
        let usedBytes = max(0.0, totalBytes - availableBytes)
        return min(1.0, usedBytes / totalBytes)
    }

    static func displayPercent(forUsageFraction usageFraction: Double) -> Int {
        Int((usageFraction * 100).rounded())
    }

    static func alertId(assistantId: String, cycle: Int) -> String {
        "disk-pressure:\(assistantId):\(cycle)"
    }
}
