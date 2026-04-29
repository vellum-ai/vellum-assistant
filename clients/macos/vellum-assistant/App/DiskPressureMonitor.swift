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
    typealias HealthzFetcher = @Sendable () async throws -> DaemonHealthz?
    typealias ActiveAssistantIdProvider = @MainActor () -> String?
    typealias ConnectedProvider = @MainActor () -> Bool

    static let triggerUsageFraction = 0.85
    /// Keep the banner visible until usage drops comfortably below the trigger.
    static let resolveUsageFraction = 0.80

    private let fetchHealthz: HealthzFetcher
    private let activeAssistantIdProvider: ActiveAssistantIdProvider
    private let isConnectedProvider: ConnectedProvider
    private let notificationCenter: NotificationCenter
    private let cadenceNanoseconds: UInt64

    private(set) var alert: DiskPressureAlert?

    @ObservationIgnored private var activeAssistantId: String?
    @ObservationIgnored private var alertCycle = 0
    @ObservationIgnored private var started = false
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var cadenceTask: Task<Void, Never>?
    @ObservationIgnored private var appActivationObserver: NSObjectProtocol?
    @ObservationIgnored private var activeAssistantObserver: NSObjectProtocol?

    init(
        fetchHealthz: @escaping HealthzFetcher = {
            let (decoded, _): (DaemonHealthz?, _) = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/healthz",
                timeout: 10
            ) { $0.keyDecodingStrategy = .convertFromSnakeCase }
            return decoded
        },
        activeAssistantIdProvider: @escaping ActiveAssistantIdProvider = {
            LockfileAssistant.loadActiveAssistantId()
        },
        isConnectedProvider: @escaping ConnectedProvider = {
            AppDelegate.shared?.connectionManager.isConnected ?? false
        },
        notificationCenter: NotificationCenter = .default,
        cadenceNanoseconds: UInt64 = 60_000_000_000
    ) {
        self.fetchHealthz = fetchHealthz
        self.activeAssistantIdProvider = activeAssistantIdProvider
        self.isConnectedProvider = isConnectedProvider
        self.notificationCenter = notificationCenter
        self.cadenceNanoseconds = cadenceNanoseconds
        self.activeAssistantId = activeAssistantIdProvider()
    }

    deinit {
        refreshTask?.cancel()
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
    }

    func stop() {
        started = false
        refreshTask?.cancel()
        refreshTask = nil
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

    func connectionStateChanged(isConnected: Bool) {
        if isConnected {
            refreshForCurrentAssistant()
        } else {
            refreshTask?.cancel()
            refreshTask = nil
            clearAlert()
        }
    }

    func refreshForCurrentAssistant() {
        let assistantId = activeAssistantIdProvider()
        updateActiveAssistant(assistantId)

        guard isConnectedProvider(), assistantId != nil else {
            refreshTask?.cancel()
            refreshTask = nil
            clearAlert()
            return
        }

        refreshTask?.cancel()
        refreshTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.fetchAndApplyHealthz(for: assistantId)
        }
    }

    func applyHealthz(_ healthz: DaemonHealthz?, assistantId: String?) {
        updateActiveAssistant(assistantId)

        guard let assistantId, let disk = healthz?.disk else {
            clearAlert()
            return
        }

        applyDiskInfo(disk, assistantId: assistantId)
    }

    private func fetchAndApplyHealthz(for assistantId: String?) async {
        do {
            let healthz = try await fetchHealthz()
            guard !Task.isCancelled else { return }
            applyHealthz(healthz, assistantId: assistantId)
        } catch {
            guard !Task.isCancelled else { return }
            log.debug("Disk-pressure healthz refresh failed: \(error.localizedDescription, privacy: .public)")
            applyHealthz(nil, assistantId: assistantId)
        }
    }

    private func updateActiveAssistant(_ assistantId: String?) {
        guard activeAssistantId != assistantId else { return }
        activeAssistantId = assistantId
        refreshTask?.cancel()
        refreshTask = nil
        clearAlert()
    }

    private func applyDiskInfo(_ disk: DaemonHealthz.DiskInfo, assistantId: String) {
        guard let usageFraction = Self.usageFraction(for: disk) else {
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

    private func clearAlert() {
        guard alert != nil else { return }
        alert = nil
    }

    static func usageFraction(for disk: DaemonHealthz.DiskInfo) -> Double? {
        guard disk.totalMb > 0, disk.usedMb.isFinite, disk.totalMb.isFinite else {
            return nil
        }
        return disk.usedMb / disk.totalMb
    }

    static func displayPercent(forUsageFraction usageFraction: Double) -> Int {
        Int((usageFraction * 100).rounded())
    }

    static func alertId(assistantId: String, cycle: Int) -> String {
        "disk-pressure:\(assistantId):\(cycle)"
    }
}
