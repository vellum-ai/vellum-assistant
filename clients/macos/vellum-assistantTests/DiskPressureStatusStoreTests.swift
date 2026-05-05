import XCTest
import VellumAssistantShared
@testable import VellumAssistantLib

@MainActor
final class DiskPressureStatusStoreTests: XCTestCase {
    func testBootstrapFetchesStatus() async throws {
        let client = MockDiskPressureClient(getStatuses: [
            Self.status(acknowledged: false),
        ])
        let eventStreamClient = EventStreamClient()
        let store = makeStore(client: client, eventStreamClient: eventStreamClient)

        store.start()

        try await waitUntil { store.requiresAcknowledgement }
        XCTAssertEqual(client.getStatusCallCount, 1)
        XCTAssertFalse(store.isCleanupModeActive)
        XCTAssertEqual(store.blockedCapabilities, [
            "agent-turns",
            "background-work",
            "remote-ingress",
        ])
        XCTAssertEqual(store.status?.usagePercent, 99)
        XCTAssertEqual(store.status?.lockId, "disk-pressure-test")
    }

    func testSSEUpdateAppliesSameViewStateAsBootstrap() async throws {
        let client = MockDiskPressureClient(getStatuses: [
            Self.status(state: "ok", locked: false, usagePercent: nil, blockedCapabilities: []),
        ])
        let eventStreamClient = EventStreamClient()
        let store = makeStore(client: client, eventStreamClient: eventStreamClient)

        store.start()
        try await waitUntil { client.getStatusCallCount == 1 }

        eventStreamClient.broadcastMessage(.diskPressureStatusChanged(DiskPressureStatusChanged(
            type: "disk_pressure_status_changed",
            status: Self.status(acknowledged: true)
        )))

        try await waitUntil { store.isCleanupModeActive }
        XCTAssertFalse(store.requiresAcknowledgement)
        XCTAssertEqual(store.blockedCapabilities, [
            "agent-turns",
            "background-work",
            "remote-ingress",
        ])
        XCTAssertEqual(store.status?.lockId, "disk-pressure-test")
    }

    func testFeatureFlagDisabledMakesStoreInert() async throws {
        let client = MockDiskPressureClient(getStatuses: [
            Self.status(),
        ])
        let eventStreamClient = EventStreamClient()
        let store = makeStore(client: client, eventStreamClient: eventStreamClient, featureEnabled: false)

        store.start()
        eventStreamClient.broadcastMessage(.diskPressureStatusChanged(DiskPressureStatusChanged(
            type: "disk_pressure_status_changed",
            status: Self.status()
        )))

        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(client.getStatusCallCount, 0)
        XCTAssertFalse(store.requiresAcknowledgement)
        XCTAssertFalse(store.isCleanupModeActive)
        XCTAssertEqual(store.blockedCapabilities, [])
        XCTAssertNil(store.status)
    }

    func testDisabledStatusClearsViewState() async throws {
        let client = MockDiskPressureClient(getStatuses: [
            Self.status(),
        ])
        let eventStreamClient = EventStreamClient()
        let store = makeStore(client: client, eventStreamClient: eventStreamClient)

        store.start()
        try await waitUntil { store.requiresAcknowledgement }

        eventStreamClient.broadcastMessage(.diskPressureStatusChanged(DiskPressureStatusChanged(
            type: "disk_pressure_status_changed",
            status: Self.status(enabled: false, state: "disabled", locked: false, usagePercent: nil, blockedCapabilities: [])
        )))

        try await waitUntil { store.status == nil }
        XCTAssertFalse(store.requiresAcknowledgement)
        XCTAssertFalse(store.isCleanupModeActive)
        XCTAssertEqual(store.blockedCapabilities, [])
    }

    func testAcknowledgementMutationUpdatesStatus() async throws {
        let client = MockDiskPressureClient(
            getStatuses: [Self.status(acknowledged: false)],
            acknowledgeStatuses: [Self.status(acknowledged: true)]
        )
        let store = makeStore(client: client, eventStreamClient: EventStreamClient())

        store.start()
        try await waitUntil { store.requiresAcknowledgement }

        store.acknowledge()

        try await waitUntil { store.isCleanupModeActive }
        XCTAssertEqual(client.acknowledgeCallCount, 1)
        XCTAssertFalse(store.requiresAcknowledgement)
    }

    func testAcknowledgementFailureShowsRetryErrorAndClearsOnStatusUpdate() async throws {
        let client = MockDiskPressureClient(getStatuses: [
            Self.status(acknowledged: false),
        ])
        let eventStreamClient = EventStreamClient()
        let store = makeStore(client: client, eventStreamClient: eventStreamClient)

        store.start()
        try await waitUntil { store.requiresAcknowledgement }

        store.acknowledge()

        try await waitUntil { store.acknowledgementErrorMessage != nil }
        XCTAssertEqual(client.acknowledgeCallCount, 1)
        XCTAssertEqual(
            store.acknowledgementErrorMessage,
            DiskPressureStatusStore.acknowledgementFailureMessage
        )

        eventStreamClient.broadcastMessage(.diskPressureStatusChanged(DiskPressureStatusChanged(
            type: "disk_pressure_status_changed",
            status: Self.status(acknowledged: true)
        )))

        try await waitUntil {
            store.acknowledgementErrorMessage == nil && store.isCleanupModeActive
        }
    }

    func testActiveAssistantSwitchFetchesNewStatusAndScopesAlert() async throws {
        let client = MockDiskPressureClient(getStatuses: [
            Self.status(lockId: "lock-a", usagePercent: 97),
            Self.status(lockId: "lock-b", usagePercent: 98),
        ])
        let eventStreamClient = EventStreamClient()
        let notificationCenter = NotificationCenter()
        var activeAssistantId = "assistant-a"
        let store = makeStore(
            client: client,
            eventStreamClient: eventStreamClient,
            activeAssistantIdProvider: { activeAssistantId },
            notificationCenter: notificationCenter
        )

        store.start()
        try await waitUntil { store.status?.lockId == "lock-a" }

        activeAssistantId = "assistant-b"
        notificationCenter.post(name: LockfileAssistant.activeAssistantDidChange, object: nil)

        try await waitUntil { store.status?.lockId == "lock-b" }
        XCTAssertEqual(client.getStatusCallCount, 2)
        XCTAssertEqual(store.status?.lockId, "lock-b")
        XCTAssertEqual(store.status?.usagePercent, 98)
    }

    private func makeStore(
        client: MockDiskPressureClient,
        eventStreamClient: EventStreamClient,
        featureEnabled: Bool = true,
        activeAssistantIdProvider: @escaping @MainActor @Sendable () -> String? = { "assistant-a" },
        notificationCenter: NotificationCenter = NotificationCenter()
    ) -> DiskPressureStatusStore {
        DiskPressureStatusStore(
            client: client,
            eventStreamClient: eventStreamClient,
            featureFlagEnabled: { key in
                key == "safe-storage-limits" ? featureEnabled : true
            },
            activeAssistantIdProvider: activeAssistantIdProvider,
            notificationCenter: notificationCenter
        )
    }

    private func waitUntil(
        timeout: TimeInterval = 2,
        condition: @escaping @MainActor () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("Timed out waiting for condition")
    }

    private static func status(
        enabled: Bool = true,
        state: String = "critical",
        locked: Bool = true,
        acknowledged: Bool = false,
        overrideActive: Bool = false,
        effectivelyLocked: Bool? = nil,
        lockId: String? = "disk-pressure-test",
        usagePercent: Double? = 99,
        thresholdPercent: Double = 95,
        blockedCapabilities: [String] = ["agent-turns", "background-work", "remote-ingress"]
    ) -> DiskPressureStatus {
        DiskPressureStatus(
            enabled: enabled,
            state: state,
            locked: locked,
            acknowledged: acknowledged,
            overrideActive: overrideActive,
            effectivelyLocked: effectivelyLocked ?? (locked && !overrideActive),
            lockId: lockId,
            usagePercent: usagePercent,
            thresholdPercent: thresholdPercent,
            path: enabled ? "/workspace" : nil,
            lastCheckedAt: enabled ? "2026-05-05T12:00:00.000Z" : nil,
            blockedCapabilities: blockedCapabilities,
            error: nil
        )
    }
}

private final class MockDiskPressureClient: DiskPressureClientProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var getStatuses: [DiskPressureStatus]
    private var acknowledgeStatuses: [DiskPressureStatus]
    private var overrideStatuses: [DiskPressureStatus]
    private var _getStatusCallCount = 0
    private var _acknowledgeCallCount = 0
    private var _overrideCallCount = 0

    init(
        getStatuses: [DiskPressureStatus] = [],
        acknowledgeStatuses: [DiskPressureStatus] = [],
        overrideStatuses: [DiskPressureStatus] = []
    ) {
        self.getStatuses = getStatuses
        self.acknowledgeStatuses = acknowledgeStatuses
        self.overrideStatuses = overrideStatuses
    }

    var getStatusCallCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return _getStatusCallCount
    }

    var acknowledgeCallCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return _acknowledgeCallCount
    }

    func getStatus() async throws -> DiskPressureStatus {
        lock.lock()
        defer { lock.unlock() }
        _getStatusCallCount += 1
        guard !getStatuses.isEmpty else { throw MockDiskPressureClientError.missingResponse }
        return getStatuses.removeFirst()
    }

    func acknowledge() async throws -> DiskPressureStatus {
        lock.lock()
        defer { lock.unlock() }
        _acknowledgeCallCount += 1
        guard !acknowledgeStatuses.isEmpty else { throw MockDiskPressureClientError.missingResponse }
        return acknowledgeStatuses.removeFirst()
    }

    func overrideLock(confirmation: String) async throws -> DiskPressureStatus {
        lock.lock()
        defer { lock.unlock() }
        _overrideCallCount += 1
        guard !overrideStatuses.isEmpty else { throw MockDiskPressureClientError.missingResponse }
        return overrideStatuses.removeFirst()
    }
}

private enum MockDiskPressureClientError: Error {
    case missingResponse
}
