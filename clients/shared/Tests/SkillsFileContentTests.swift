import Foundation
import XCTest

@testable import VellumAssistantShared

// MARK: - Mock URLProtocol for SkillsClient HTTP tests

private final class MockSkillsFileContentURLProtocol: URLProtocol {
    static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let handler = Self.requestHandler else {
            XCTFail("requestHandler not set")
            return
        }

        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

// MARK: - Mock SkillsClient for SkillsStore tests

private actor MockSkillsFileContentStore {
    private var fileContentResponses: [String: SkillFileContentResponse] = [:]
    private(set) var requestedPaths: [(skillId: String, path: String)] = []
    private var continuations: [String: [CheckedContinuation<SkillFileContentResponse?, Never>]] = [:]
    private var blockingPaths: Set<String> = []

    /// Ordered log of `fetchSkillFiles(skillId:)` calls issued through the
    /// mock client. Tests use this to assert that the store reissues a
    /// same-skill re-fetch (e.g. during the install-from-preview transition)
    /// rather than short-circuiting when `currentFilesSkillId` is unchanged.
    private(set) var fetchSkillFilesRequests: [String] = []

    func setResponse(for path: String, _ response: SkillFileContentResponse?) {
        if let response {
            fileContentResponses[path] = response
        } else {
            fileContentResponses.removeValue(forKey: path)
        }
    }

    func setBlocking(for path: String) {
        blockingPaths.insert(path)
    }

    func record(skillId: String, path: String) {
        requestedPaths.append((skillId: skillId, path: path))
    }

    func recordFetchSkillFiles(skillId: String) {
        fetchSkillFilesRequests.append(skillId)
    }

    func fetchSkillFilesCount() -> Int {
        fetchSkillFilesRequests.count
    }

    func awaitResponse(skillId: String, path: String) async -> SkillFileContentResponse? {
        record(skillId: skillId, path: path)
        if blockingPaths.contains(path) {
            return await withCheckedContinuation { cont in
                continuations[path, default: []].append(cont)
            }
        }
        // Default to nil when no response has been configured.
        return fileContentResponses[path]
    }

    func pendingContinuationCount(for path: String) -> Int {
        continuations[path]?.count ?? 0
    }

    func unblock(path: String, with response: SkillFileContentResponse?) {
        guard var queue = continuations[path], !queue.isEmpty else { return }
        let cont = queue.removeFirst()
        if queue.isEmpty {
            continuations.removeValue(forKey: path)
            blockingPaths.remove(path)
        } else {
            continuations[path] = queue
        }
        cont.resume(returning: response)
    }

    func requestCount() -> Int { requestedPaths.count }
}

private struct MockSkillsClient: SkillsClientProtocol {
    let backing: MockSkillsFileContentStore

    func fetchSkillsList(includeCatalog: Bool, origin: String?, kind: String?, query: String?, category: String?) async -> SkillsListResponseMessage? { nil }
    func enableSkill(name: String) async -> SkillOperationResult? { nil }
    func disableSkill(name: String) async -> SkillOperationResult? { nil }
    func configureSkill(name: String, env: [String: String]?, apiKey: String?, config: [String: AnyCodable]?) async -> SkillOperationResult? { nil }
    func installSkill(slug: String, version: String?) async -> SkillOperationResult? { nil }
    func uninstallSkill(name: String) async -> SkillOperationResult? { nil }
    func updateSkill(name: String) async -> SkillOperationResult? { nil }
    func checkSkillUpdates() async -> SkillOperationResult? { nil }
    func searchSkills(query: String) async -> SkillSearchResult? { nil }
    func draftSkill(sourceText: String) async -> SkillsDraftResponseMessage? { nil }
    func createSkill(skillId: String, name: String, description: String, emoji: String?, bodyMarkdown: String, overwrite: Bool?) async -> SkillOperationResult? { nil }
    func fetchSkillDetail(skillId: String) async -> SkillDetailHTTPResponse? { nil }
    func fetchSkillFiles(skillId: String) async -> SkillDetailFilesHTTPResponse? {
        // Tests drive `currentFilesSkillId` via `fetchSkillFiles` and count
        // how many times it is reissued (e.g. for the install-from-preview
        // re-fetch path); the response body itself is irrelevant to the
        // loadSkillFileContent code paths.
        await backing.recordFetchSkillFiles(skillId: skillId)
        return nil
    }

    func fetchSkillFileContent(skillId: String, path: String) async -> SkillFileContentResponse? {
        await backing.awaitResponse(skillId: skillId, path: path)
    }
}

// MARK: - SkillsClient HTTP tests

@MainActor
final class SkillsFileContentClientTests: XCTestCase {
    private let assistantId = "assistant-skill-file-content-test"
    private let gatewayPort = 7841
    private var originalPrimaryLockfileData: Data?
    private var primaryLockfileExisted = false

    override func setUpWithError() throws {
        try super.setUpWithError()
        MockSkillsFileContentURLProtocol.requestHandler = nil
        URLProtocol.registerClass(MockSkillsFileContentURLProtocol.self)

        let primaryLockfileURL = LockfilePaths.primary
        primaryLockfileExisted = FileManager.default.fileExists(atPath: primaryLockfileURL.path)
        if primaryLockfileExisted {
            originalPrimaryLockfileData = try Data(contentsOf: primaryLockfileURL)
        }

        try installLockfileFixture()
    }

    override func tearDownWithError() throws {
        URLProtocol.unregisterClass(MockSkillsFileContentURLProtocol.self)
        MockSkillsFileContentURLProtocol.requestHandler = nil

        if primaryLockfileExisted {
            try originalPrimaryLockfileData?.write(to: LockfilePaths.primary, options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: LockfilePaths.primary)
        }

        try super.tearDownWithError()
    }

    func testFetchSkillFileContentDecodesSuccessResponse() async throws {
        let requestExpectation = expectation(description: "skill file content request")
        var capturedRequest: URLRequest?

        MockSkillsFileContentURLProtocol.requestHandler = { request in
            capturedRequest = request
            requestExpectation.fulfill()

            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            let data = Data(
                #"""
                {
                  "path": "scripts/run.py",
                  "name": "run.py",
                  "size": 42,
                  "mimeType": "text/x-python",
                  "isBinary": false,
                  "content": "print('hi')"
                }
                """#.utf8
            )
            return (response, data)
        }

        let client = SkillsClient()
        let result = await client.fetchSkillFileContent(
            skillId: "my-skill",
            path: "scripts/run.py"
        )

        await fulfillment(of: [requestExpectation], timeout: 1.0)

        let url = try XCTUnwrap(capturedRequest?.url)
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.host, "127.0.0.1")
        XCTAssertEqual(components.port, gatewayPort)
        XCTAssertTrue(
            components.path.hasPrefix(
                "/v1/assistants/\(assistantId)/skills/my-skill/files/content"
            ),
            "Unexpected path: \(components.path)"
        )
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "path" })?.value, "scripts/run.py")
        XCTAssertEqual(capturedRequest?.httpMethod, "GET")

        XCTAssertEqual(result?.path, "scripts/run.py")
        XCTAssertEqual(result?.name, "run.py")
        XCTAssertEqual(result?.size, 42)
        XCTAssertEqual(result?.mimeType, "text/x-python")
        XCTAssertFalse(result?.isBinary ?? true)
        XCTAssertEqual(result?.content, "print('hi')")
    }

    func testFetchSkillFileContentReturnsNilForNonSuccessStatus() async {
        MockSkillsFileContentURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 500,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"error":{"message":"boom"}}"#.utf8))
        }

        let client = SkillsClient()
        let result = await client.fetchSkillFileContent(
            skillId: "my-skill",
            path: "scripts/run.py"
        )
        XCTAssertNil(result)
    }

    private func installLockfileFixture() throws {
        let lockfile: [String: Any] = [
            "activeAssistant": assistantId,
            "assistants": [
                [
                    "assistantId": assistantId,
                    "cloud": "local",
                    "hatchedAt": "2026-03-19T12:00:00Z",
                    "resources": [
                        "gatewayPort": gatewayPort,
                    ],
                ],
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: lockfile, options: [.sortedKeys])
        try data.write(to: LockfilePaths.primary, options: .atomic)
    }
}

// MARK: - SkillsStore tests

@MainActor
final class SkillsFileContentStoreTests: XCTestCase {

    func testLoadSkillFileContentTracksLoadingThenPopulatesContent() async throws {
        let backing = MockSkillsFileContentStore()
        await backing.setBlocking(for: "docs/intro.md")
        let mock = MockSkillsClient(backing: backing)
        let store = SkillsStore(skillsClient: mock)

        // Seed currentFilesSkillId via a fetchSkillFiles call so loadSkillFileContent
        // can satisfy its "same skillId" guard when storing the result.
        store.fetchSkillFiles(skillId: "my-skill")
        try await Task.sleep(nanoseconds: 20_000_000)

        store.loadSkillFileContent(skillId: "my-skill", path: "docs/intro.md")
        XCTAssertTrue(store.loadingFilePaths.contains("docs/intro.md"))
        XCTAssertNil(store.loadedFileContents["docs/intro.md"])

        let response = SkillFileContentResponse(
            path: "docs/intro.md",
            name: "intro.md",
            size: 5,
            mimeType: "text/markdown",
            isBinary: false,
            content: "hello"
        )
        await backing.unblock(path: "docs/intro.md", with: response)

        // Yield to let the Task finish its MainActor.run block.
        try await waitUntil(timeout: 1.0) {
            !store.loadingFilePaths.contains("docs/intro.md")
        }

        XCTAssertEqual(store.loadedFileContents["docs/intro.md"], "hello")
        XCTAssertNil(store.fileContentErrors["docs/intro.md"])
    }

    func testLoadSkillFileContentSetsErrorOnFailure() async throws {
        let backing = MockSkillsFileContentStore()
        await backing.setResponse(for: "missing.txt", nil)
        let mock = MockSkillsClient(backing: backing)
        let store = SkillsStore(skillsClient: mock)

        store.fetchSkillFiles(skillId: "my-skill")
        try await Task.sleep(nanoseconds: 20_000_000)

        store.loadSkillFileContent(skillId: "my-skill", path: "missing.txt")

        try await waitUntil(timeout: 1.0) {
            store.fileContentErrors["missing.txt"] != nil
        }

        XCTAssertEqual(store.fileContentErrors["missing.txt"], "Failed to load file content")
        XCTAssertNil(store.loadedFileContents["missing.txt"])
        XCTAssertFalse(store.loadingFilePaths.contains("missing.txt"))
    }

    func testLoadSkillFileContentTreatsOversizedTextAsNoPreview() async throws {
        // The daemon returns `content: null` for text files above
        // `MAX_INLINE_TEXT_SIZE`. `loadSkillFileContent` must treat that as
        // "no preview available" and clear the loading flag without
        // surfacing a spurious error or populating `loadedFileContents`.
        // The detail view then falls through to its "Select a file to
        // view" empty state for the oversized file.
        let backing = MockSkillsFileContentStore()
        await backing.setBlocking(for: "large.md")
        let mock = MockSkillsClient(backing: backing)
        let store = SkillsStore(skillsClient: mock)

        // Seed `currentFilesSkillId` so `loadSkillFileContent`'s
        // same-skill guard lets the result reach the completion branch.
        store.fetchSkillFiles(skillId: "test-skill")
        try await Task.sleep(nanoseconds: 20_000_000)

        store.loadSkillFileContent(skillId: "test-skill", path: "large.md")
        XCTAssertTrue(store.loadingFilePaths.contains("large.md"))

        // Unblock the mock with a text-file response that has
        // `content: nil` — the oversized-text shape the daemon emits.
        let oversizedResponse = SkillFileContentResponse(
            path: "large.md",
            name: "large.md",
            size: 10_000_000,
            mimeType: "text/markdown",
            isBinary: false,
            content: nil
        )
        await backing.unblock(path: "large.md", with: oversizedResponse)

        try await waitUntil(timeout: 1.0) {
            !store.loadingFilePaths.contains("large.md")
        }

        XCTAssertNil(
            store.loadedFileContents["large.md"],
            "Oversized text file must not populate loadedFileContents"
        )
        XCTAssertNil(
            store.fileContentErrors["large.md"],
            "Oversized text file must not be surfaced as an error"
        )
        XCTAssertFalse(
            store.loadingFilePaths.contains("large.md"),
            "Loading flag must be cleared after the response is handled"
        )
    }

    func testLoadSkillFileContentIgnoresStaleCancelledTaskCompletion() async throws {
        let backing = MockSkillsFileContentStore()
        await backing.setBlocking(for: "docs/readme.md")
        let mock = MockSkillsClient(backing: backing)
        let store = SkillsStore(skillsClient: mock)

        store.fetchSkillFiles(skillId: "my-skill")
        try await Task.sleep(nanoseconds: 20_000_000)

        // Task A: starts the first fetch and parks on the continuation.
        store.loadSkillFileContent(skillId: "my-skill", path: "docs/readme.md")
        try await waitUntilAsync(timeout: 1.0) {
            await backing.pendingContinuationCount(for: "docs/readme.md") >= 1
        }

        // Task B: a second call for the same path cancels Task A and parks
        // on its own continuation.
        store.loadSkillFileContent(skillId: "my-skill", path: "docs/readme.md")
        try await waitUntilAsync(timeout: 1.0) {
            await backing.pendingContinuationCount(for: "docs/readme.md") >= 2
        }

        XCTAssertTrue(store.loadingFilePaths.contains("docs/readme.md"))

        // Resume Task A with a failure-shaped response. Because Task A was
        // cancelled, the Task.isCancelled guard in loadSkillFileContent must
        // prevent it from mutating loadingFilePaths/fileContentErrors.
        await backing.unblock(path: "docs/readme.md", with: nil)

        // Give Task A a chance to run its (guarded) completion.
        try await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertTrue(
            store.loadingFilePaths.contains("docs/readme.md"),
            "Cancelled Task A must not clear the loading flag"
        )
        XCTAssertNil(
            store.fileContentErrors["docs/readme.md"],
            "Cancelled Task A must not set a spurious error"
        )

        // Resume Task B with a success response and verify it wins.
        let success = SkillFileContentResponse(
            path: "docs/readme.md",
            name: "readme.md",
            size: 3,
            mimeType: "text/markdown",
            isBinary: false,
            content: "yay"
        )
        await backing.unblock(path: "docs/readme.md", with: success)

        try await waitUntil(timeout: 1.0) {
            !store.loadingFilePaths.contains("docs/readme.md")
        }

        XCTAssertEqual(store.loadedFileContents["docs/readme.md"], "yay")
        XCTAssertNil(store.fileContentErrors["docs/readme.md"])
    }

    func testFetchSkillFilesReIssuesRequestForSameSkillId() async throws {
        // Regression coverage for the install-from-preview transition. When
        // the detail view re-calls `fetchSkillFiles(skillId:)` for the same
        // skill (because an install just flipped `skill.kind` from
        // "catalog" to "installed"/"bundled"), the store must reissue the
        // request rather than short-circuiting on a `currentFilesSkillId`
        // match. Otherwise the right pane of the detail view is stuck
        // showing the lazy/null-content preview payload with no inline
        // content.
        let backing = MockSkillsFileContentStore()
        let mock = MockSkillsClient(backing: backing)
        let store = SkillsStore(skillsClient: mock)

        store.fetchSkillFiles(skillId: "my-skill")
        try await waitUntilAsync(timeout: 1.0) {
            await backing.fetchSkillFilesCount() >= 1
        }

        store.fetchSkillFiles(skillId: "my-skill")
        try await waitUntilAsync(timeout: 1.0) {
            await backing.fetchSkillFilesCount() >= 2
        }

        let totalRequests = await backing.fetchSkillFilesCount()
        XCTAssertEqual(
            totalRequests,
            2,
            "Same-skill re-fetch must reissue the request so install-from-preview can replace lazy content"
        )
    }

    func testClearLoadedFileContentsCancelsTasksAndClearsState() async throws {
        let backing = MockSkillsFileContentStore()
        await backing.setBlocking(for: "long-path.md")
        let mock = MockSkillsClient(backing: backing)
        let store = SkillsStore(skillsClient: mock)

        store.fetchSkillFiles(skillId: "my-skill")
        try await Task.sleep(nanoseconds: 20_000_000)

        store.loadSkillFileContent(skillId: "my-skill", path: "long-path.md")
        XCTAssertTrue(store.loadingFilePaths.contains("long-path.md"))

        // Prime loadedFileContents and fileContentErrors directly so we can verify
        // that clearLoadedFileContents wipes all three dictionaries.
        store.loadedFileContents["existing.md"] = "cached"
        store.fileContentErrors["broken.md"] = "oops"

        store.clearLoadedFileContents()

        XCTAssertTrue(store.loadedFileContents.isEmpty)
        XCTAssertTrue(store.loadingFilePaths.isEmpty)
        XCTAssertTrue(store.fileContentErrors.isEmpty)

        // Unblock the (now-cancelled) request so the actor isn't left waiting —
        // even if the task already observed cancellation, this is a no-op.
        await backing.unblock(path: "long-path.md", with: nil)
    }

    // MARK: - Helpers

    private func waitUntil(
        timeout: TimeInterval,
        _ condition: @MainActor () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Condition not met within \(timeout) seconds")
    }

    private func waitUntilAsync(
        timeout: TimeInterval,
        _ condition: @Sendable () async -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Condition not met within \(timeout) seconds")
    }
}
