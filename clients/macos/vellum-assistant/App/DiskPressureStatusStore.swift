import AppKit
import Foundation
import Observation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "DiskPressureStatusStore")

@MainActor
@Observable
final class DiskPressureStatusStore {
    typealias ActiveAssistantIdProvider = @MainActor @Sendable () -> String?
    typealias FeatureFlagEnabledProvider = @MainActor @Sendable (String) -> Bool
    static let acknowledgementFailureMessage = "Unable to acknowledge storage cleanup. Check your connection and try again."

    @ObservationIgnored private let client: any DiskPressureClientProtocol
    @ObservationIgnored private let eventStreamClient: EventStreamClient?
    @ObservationIgnored private let featureFlagEnabled: FeatureFlagEnabledProvider
    @ObservationIgnored private let activeAssistantIdProvider: ActiveAssistantIdProvider
    @ObservationIgnored private let notificationCenter: NotificationCenter

    private(set) var status: DiskPressureStatus?
    private(set) var acknowledgementErrorMessage: String?

    @ObservationIgnored private var activeAssistantId: String?
    @ObservationIgnored private var started = false
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var bootstrapTask: Task<Void, Never>?
    @ObservationIgnored private var appActivationObserver: NSObjectProtocol?
    @ObservationIgnored private var activeAssistantObserver: NSObjectProtocol?
    @ObservationIgnored private var generation = 0

    init(
        client: any DiskPressureClientProtocol = DiskPressureClient(),
        eventStreamClient: EventStreamClient? = nil,
        featureFlagEnabled: @escaping FeatureFlagEnabledProvider,
        activeAssistantIdProvider: @escaping ActiveAssistantIdProvider = {
            LockfileAssistant.loadActiveAssistantId()
        },
        notificationCenter: NotificationCenter = .default
    ) {
        self.client = client
        self.eventStreamClient = eventStreamClient
        self.featureFlagEnabled = featureFlagEnabled
        self.activeAssistantIdProvider = activeAssistantIdProvider
        self.notificationCenter = notificationCenter
        self.activeAssistantId = activeAssistantIdProvider()
    }

    deinit {
        eventTask?.cancel()
        bootstrapTask?.cancel()
        if let appActivationObserver {
            notificationCenter.removeObserver(appActivationObserver)
        }
        if let activeAssistantObserver {
            notificationCenter.removeObserver(activeAssistantObserver)
        }
    }

    var requiresAcknowledgement: Bool {
        guard let status = activeStatus else { return false }
        return status.locked && !status.acknowledged && !status.overrideActive
    }

    var isCleanupModeActive: Bool {
        guard let status = activeStatus else { return false }
        return status.locked && status.acknowledged && status.effectivelyLocked
    }

    var blockedCapabilities: [String] {
        guard let status = activeStatus, status.effectivelyLocked else { return [] }
        return status.blockedCapabilities
    }

    private var activeStatus: DiskPressureStatus? {
        guard featureFlagEnabled("safe-storage-limits"),
              let status,
              status.enabled,
              status.state != "disabled"
        else {
            return nil
        }
        return status
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

        subscribeToEvents()
        refreshForCurrentAssistant()
    }

    func stop() {
        started = false
        eventTask?.cancel()
        eventTask = nil
        bootstrapTask?.cancel()
        bootstrapTask = nil
        clearStatus()

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
        if assistantId != activeAssistantId {
            activeAssistantId = assistantId
            clearStatus()
        }

        guard assistantId != nil, featureFlagEnabled("safe-storage-limits") else {
            clearStatus()
            return
        }

        generation += 1
        let requestGeneration = generation
        bootstrapTask?.cancel()
        bootstrapTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let nextStatus = try await self.client.getStatus()
                guard !Task.isCancelled, requestGeneration == self.generation else { return }
                self.applyStatus(nextStatus)
            } catch {
                guard !Task.isCancelled else { return }
                log.warning("Disk pressure status fetch failed: \(error.localizedDescription)")
            }
        }
    }

    func acknowledge() {
        guard featureFlagEnabled("safe-storage-limits") else { return }
        acknowledgementErrorMessage = nil
        generation += 1
        let requestGeneration = generation
        bootstrapTask?.cancel()
        bootstrapTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let nextStatus = try await self.client.acknowledge()
                guard !Task.isCancelled, requestGeneration == self.generation else { return }
                self.applyStatus(nextStatus)
            } catch {
                guard !Task.isCancelled else { return }
                guard requestGeneration == self.generation else { return }
                self.acknowledgementErrorMessage = Self.acknowledgementFailureMessage
                log.warning("Disk pressure acknowledgement failed: \(error.localizedDescription)")
            }
        }
    }

    func overrideLock(confirmation: String) {
        guard featureFlagEnabled("safe-storage-limits") else { return }
        generation += 1
        let requestGeneration = generation
        bootstrapTask?.cancel()
        bootstrapTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let nextStatus = try await self.client.overrideLock(confirmation: confirmation)
                guard !Task.isCancelled, requestGeneration == self.generation else { return }
                self.applyStatus(nextStatus)
            } catch {
                guard !Task.isCancelled else { return }
                log.warning("Disk pressure override failed: \(error.localizedDescription)")
            }
        }
    }

    func handle(_ message: ServerMessage) {
        switch message {
        case .diskPressureStatusChanged(let event):
            applyStatus(event.status)
        case .featureFlagsChanged:
            refreshForCurrentAssistant()
        default:
            break
        }
    }

    private func subscribeToEvents() {
        guard eventTask == nil, let eventStreamClient else { return }
        eventTask = Task { @MainActor [weak self] in
            guard let self else { return }
            for await message in eventStreamClient.subscribe() {
                guard !Task.isCancelled else { break }
                self.handle(message)
            }
        }
    }

    private func applyStatus(_ nextStatus: DiskPressureStatus) {
        guard featureFlagEnabled("safe-storage-limits"),
              nextStatus.enabled,
              nextStatus.state != "disabled"
        else {
            clearStatus()
            return
        }

        status = nextStatus
        acknowledgementErrorMessage = nil
    }

    private func clearStatus() {
        guard status != nil || acknowledgementErrorMessage != nil else { return }
        status = nil
        acknowledgementErrorMessage = nil
    }
}
