import XCTest

@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
private final class SharedAppsTestClient: DaemonClientProtocol {
    var isConnected: Bool = true
    var sentMessages: [Any] = []
    private var continuations: [AsyncStream<ServerMessage>.Continuation] = []

    func subscribe() -> AsyncStream<ServerMessage> {
        AsyncStream { continuation in
            continuations.append(continuation)
        }
    }

    func send<T: Encodable>(_ message: T) throws {
        sentMessages.append(message)
    }

    func connect() async throws {}
    func disconnect() {}
    func startSSE() {}
    func stopSSE() {}

    func emit(_ message: ServerMessage) {
        for continuation in continuations {
            continuation.yield(message)
        }
    }
}

@MainActor
private final class ThrowingSharedAppsClient: DaemonClientProtocol {
    struct ExpectedError: Error, Equatable {}

    var isConnected: Bool = true

    func subscribe() -> AsyncStream<ServerMessage> {
        AsyncStream { _ in }
    }

    func send<T: Encodable>(_ message: T) throws {
        throw ExpectedError()
    }

    func connect() async throws {}
    func disconnect() {}
    func startSSE() {}
    func stopSSE() {}
}

@MainActor
final class SharedAppsLoaderTests: XCTestCase {
    func testLoadReturnsAppsFromSharedAppsResponse() async throws {
        let client = SharedAppsTestClient()

        let loadTask = Task {
            try await SharedAppsLoader.load(
                using: client,
                timeoutNanoseconds: 1_000_000_000
            )
        }

        await Task.yield()
        client.emit(.sharedAppsListResponse(IPCSharedAppsListResponse(
            type: "shared_apps_list_response",
            apps: [
                IPCSharedAppsListResponseApp(
                    uuid: "shared-1",
                    name: "Shared Things",
                    description: "Shared app",
                    icon: "📱",
                    preview: nil,
                    entry: "index.html",
                    trustTier: "trusted",
                    signerDisplayName: "Aaron",
                    bundleSizeBytes: 1024,
                    installedAt: "2026-03-09T00:00:00Z",
                    version: "1.0.0",
                    contentId: "cid-1",
                    updateAvailable: true
                )
            ]
        )))

        let apps = try await loadTask.value
        XCTAssertEqual(apps.count, 1)
        XCTAssertEqual(apps[0].uuid, "shared-1")
        XCTAssertTrue(client.sentMessages.first is SharedAppsListRequestMessage)
    }

    func testLoadIgnoresUnrelatedMessages() async throws {
        let client = SharedAppsTestClient()

        let loadTask = Task {
            try await SharedAppsLoader.load(
                using: client,
                timeoutNanoseconds: 1_000_000_000
            )
        }

        await Task.yield()
        client.emit(.appsListResponse(IPCAppsListResponse(
            type: "apps_list_response",
            apps: [
                IPCAppsListResponseApp(
                    id: "local-1",
                    name: "Local Things",
                    description: nil,
                    icon: nil,
                    preview: nil,
                    createdAt: 123
                )
            ]
        )))
        client.emit(.sharedAppsListResponse(IPCSharedAppsListResponse(
            type: "shared_apps_list_response",
            apps: [
                IPCSharedAppsListResponseApp(
                    uuid: "shared-2",
                    name: "Shared Followup",
                    description: nil,
                    icon: nil,
                    preview: nil,
                    entry: "index.html",
                    trustTier: "trusted",
                    signerDisplayName: nil,
                    bundleSizeBytes: 512,
                    installedAt: "2026-03-09T00:00:00Z"
                )
            ]
        )))

        let apps = try await loadTask.value
        XCTAssertEqual(apps.count, 1)
        XCTAssertEqual(apps[0].uuid, "shared-2")
    }

    func testLoadTimesOutWhenNoSharedAppsResponseArrives() async {
        let client = SharedAppsTestClient()

        do {
            _ = try await SharedAppsLoader.load(
                using: client,
                timeoutNanoseconds: 1_000_000
            )
            XCTFail("Expected SharedAppsLoader.load to time out")
        } catch let error as SharedAppsLoader.LoadError {
            XCTAssertEqual(error, .timedOut)
        } catch {
            XCTFail("Expected SharedAppsLoader.LoadError, got \(error)")
        }
    }

    func testLoadPropagatesSendFailure() async {
        let client = ThrowingSharedAppsClient()

        do {
            _ = try await SharedAppsLoader.load(using: client)
            XCTFail("Expected SharedAppsLoader.load to throw")
        } catch is ThrowingSharedAppsClient.ExpectedError {
            // Expected.
        } catch {
            XCTFail("Expected send failure, got \(error)")
        }
    }
}
