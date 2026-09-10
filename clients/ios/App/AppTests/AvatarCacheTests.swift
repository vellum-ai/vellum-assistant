import XCTest

final class AvatarCacheTests: XCTestCase {
    private var root: URL!
    private var cache: AvatarCache!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("AvatarCache-\(UUID().uuidString)", isDirectory: true)
        cache = AvatarCache(rootURL: root)
        URLProtocol.registerClass(CountingURLProtocol.self)
        loadCounter.reset()
        stubbedResponse.clear()
    }

    override func tearDown() {
        URLProtocol.unregisterClass(CountingURLProtocol.self)
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    private func avatar(_ index: Int) -> Data {
        Data("avatar-\(index)".utf8)
    }

    private func storedFileCount() -> Int {
        let files = (try? FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []
        return files.count
    }

    func testStoreAndReadRoundTrip() {
        let bytes = avatar(1)
        let hash = AvatarCache.sha256Hex(bytes)
        cache.store(bytes, hash: hash)
        XCTAssertEqual(cache.data(forHash: hash), bytes)
    }

    func testReadsNilForAnUncachedHash() {
        XCTAssertNil(cache.data(forHash: AvatarCache.sha256Hex(avatar(1))))
    }

    func testRejectsBytesThatDoNotMatchTheHash() {
        let hash = AvatarCache.sha256Hex(avatar(1))
        cache.store(avatar(2), hash: hash)
        XCTAssertNil(cache.data(forHash: hash))
        XCTAssertEqual(storedFileCount(), 0)
    }

    func testRejectsHashesThatAreNotLowercaseHex() {
        XCTAssertFalse(AvatarCache.isValidHash(String(repeating: "A", count: 64)))
        XCTAssertFalse(AvatarCache.isValidHash(String(repeating: "a", count: 63)))
        XCTAssertFalse(AvatarCache.isValidHash("../etc/passwd"))
        XCTAssertTrue(AvatarCache.isValidHash(AvatarCache.sha256Hex(avatar(1))))
        XCTAssertNil(cache.fileURL(forHash: "../etc/passwd"))
    }

    func testEvictsTheOldestEntryOnTheNinthStore() throws {
        let hashes = (0..<9).map { AvatarCache.sha256Hex(avatar($0)) }
        for index in 0..<8 {
            cache.store(avatar(index), hash: hashes[index])
        }
        XCTAssertEqual(storedFileCount(), 8)

        // Pin one entry as the oldest so the eviction order does not depend on
        // how quickly the writes above landed.
        let oldest = try XCTUnwrap(cache.fileURL(forHash: hashes[3]))
        try FileManager.default.setAttributes(
            [.modificationDate: Date.distantPast],
            ofItemAtPath: oldest.path
        )

        cache.store(avatar(8), hash: hashes[8])
        XCTAssertEqual(storedFileCount(), 8)
        XCTAssertNil(cache.data(forHash: hashes[3]))
        XCTAssertEqual(cache.data(forHash: hashes[8]), avatar(8))
    }

    func testAReadRefreshesRecencySoTheNextStoreEvictsAnOlderEntry() throws {
        let hashes = (0..<9).map { AvatarCache.sha256Hex(avatar($0)) }
        for index in 0..<8 {
            cache.store(avatar(index), hash: hashes[index])
        }

        // Spread the entries over a known order so eviction does not depend on
        // how quickly the writes above landed: entry 0 is oldest, entry 7 newest.
        for index in 0..<8 {
            let url = try XCTUnwrap(cache.fileURL(forHash: hashes[index]))
            try FileManager.default.setAttributes(
                [.modificationDate: Date(timeIntervalSince1970: TimeInterval(1_000 + index))],
                ofItemAtPath: url.path
            )
        }

        XCTAssertEqual(cache.data(forHash: hashes[0]), avatar(0))

        cache.store(avatar(8), hash: hashes[8])
        XCTAssertEqual(storedFileCount(), 8)
        XCTAssertNil(cache.data(forHash: hashes[1]))
        XCTAssertEqual(cache.data(forHash: hashes[0]), avatar(0))
    }

    func testDropsACachedFilePastTheByteCap() throws {
        let oversized = Data(repeating: 0x41, count: AvatarCache.maxBytes + 1)
        let hash = AvatarCache.sha256Hex(oversized)
        let url = try XCTUnwrap(cache.fileURL(forHash: hash))
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try oversized.write(to: url)

        XCTAssertNil(cache.data(forHash: hash))
        XCTAssertEqual(storedFileCount(), 0)
    }

    /// `attributesOfItem` reports a symlink's own size while `Data(contentsOf:)`
    /// follows it, so a link is measured against the wrong file and the byte cap
    /// bounds nothing. The target here holds the very bytes the name promises,
    /// which leaves the entry's type as the only thing that can reject it.
    func testDropsACachedEntryThatIsASymlink() throws {
        let bytes = avatar(1)
        let hash = AvatarCache.sha256Hex(bytes)
        let link = try XCTUnwrap(cache.fileURL(forHash: hash))
        let target = root.appendingPathComponent("elsewhere.png", isDirectory: false)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try bytes.write(to: target)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)

        XCTAssertNil(cache.data(forHash: hash))
        XCTAssertFalse(FileManager.default.fileExists(atPath: link.path))
        // Only the link is removed: the container is shared with the app, whose
        // own files a cache read has no business deleting.
        XCTAssertTrue(FileManager.default.fileExists(atPath: target.path))
    }

    func testDropsACachedFileWhoseBytesNoLongerMatchItsName() throws {
        let hash = AvatarCache.sha256Hex(avatar(1))
        let url = try XCTUnwrap(cache.fileURL(forHash: hash))
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try avatar(2).write(to: url)

        XCTAssertNil(cache.data(forHash: hash))
        XCTAssertEqual(storedFileCount(), 0)
    }

    func testReadsUpToTheByteCap() async throws {
        let atCap = ByteFeed(count: 16)
        let atCapBytes = try await AvatarCache.readAtMost(16, from: atCap.stream())
        XCTAssertEqual(atCapBytes?.count, 16)
        XCTAssertEqual(atCap.produced, 16)

        let underCap = ByteFeed(count: 4)
        let underCapBytes = try await AvatarCache.readAtMost(16, from: underCap.stream())
        XCTAssertEqual(underCapBytes?.count, 4)
    }

    func testReadsABodyThatSpansSeveralBufferedChunks() async throws {
        let count = AvatarCache.readChunkSize * 2 + 7
        let feed = ByteFeed(count: count)
        let bytes = try await AvatarCache.readAtMost(AvatarCache.maxBytes, from: feed.stream())
        XCTAssertEqual(bytes?.count, count)
        XCTAssertEqual(feed.produced, count)
    }

    func testStopsReadingPastTheByteCap() async throws {
        let feed = ByteFeed(count: 4_096)
        let bytes = try await AvatarCache.readAtMost(16, from: feed.stream())
        XCTAssertNil(bytes)
        // One byte past the cap is enough to know the body is too large, so the
        // rest of the response is never pulled into memory, buffered chunk or
        // not.
        XCTAssertEqual(feed.produced, 17)
    }

    /// The request's idle timeout only bounds a stall, so a body arriving
    /// steadily but far too slowly needs a deadline of its own.
    func testStopsReadingOnceTheDeadlineHasPassed() async throws {
        let feed = ByteFeed(count: 4_096)
        do {
            _ = try await AvatarCache.readAtMost(
                AvatarCache.maxBytes,
                from: feed.stream(),
                within: .zero
            )
            XCTFail("expected the read to give up on the deadline")
        } catch let reason as AvatarCache.UnavailableReason {
            XCTAssertEqual(reason, .timedOut)
        }
        // The clock is read per byte, so a spent budget stops the read at the
        // first one rather than at some multiple of it.
        XCTAssertEqual(feed.produced, 1)
    }

    /// A host answering one byte at a time is what the budget exists for, and
    /// what any amortized checking interval lets through: the whole body can be
    /// shorter than the interval and still take longer than the budget.
    func testGivesUpOnAHostTricklingOneByteAtATime() async throws {
        let feed = ByteFeed(millisecondsPerByte: 20)
        do {
            _ = try await AvatarCache.readAtMost(
                AvatarCache.maxBytes,
                from: feed.stream(),
                within: .milliseconds(100)
            )
            XCTFail("expected the read to give up on the deadline")
        } catch let reason as AvatarCache.UnavailableReason {
            XCTAssertEqual(reason, .timedOut)
        }
        // At this pace 50 bytes take a full second, ten times the budget.
        XCTAssertLessThan(feed.produced, 50)
    }

    func testFetchRefusesANonHttpsURL() async throws {
        let url = try XCTUnwrap(URL(string: "http://storage.example.com/avatar.png"))
        let result = await cache.fetch(url: url, hash: AvatarCache.sha256Hex(avatar(1)))
        XCTAssertEqual(result.reason, .insecureURL)
        XCTAssertEqual(loadCounter.count, 0)
    }

    func testFetchRefusesAMalformedHash() async throws {
        let url = try XCTUnwrap(URL(string: "https://storage.example.com/avatar.png"))
        let result = await cache.fetch(url: url, hash: "../etc/passwd")
        XCTAssertEqual(result.reason, .badHash)
        XCTAssertEqual(loadCounter.count, 0)
    }

    /// Proves the two guards above are what stopped the request, rather than a
    /// stub that never intercepts: the same call with both guards satisfied
    /// does reach the URL loading system.
    func testFetchReachesTheNetworkOnceTheGuardsPass() async throws {
        let url = try XCTUnwrap(URL(string: "https://storage.example.com/avatar.png"))
        let result = await cache.fetch(url: url, hash: AvatarCache.sha256Hex(avatar(1)))
        XCTAssertEqual(result.reason, .requestFailed)
        XCTAssertEqual(loadCounter.count, 1)
    }

    /// A chunked response declares no length at all, so a fetch that insisted on
    /// a declared one would miss every cache and refill it from nothing.
    func testFetchAcceptsAResponseThatDeclaresNoLength() async throws {
        let bytes = avatar(1)
        let hash = AvatarCache.sha256Hex(bytes)
        stubbedResponse.set(headerFields: [:], body: bytes)

        let url = try XCTUnwrap(URL(string: "https://storage.example.com/avatar.png"))
        let result = await cache.fetch(url: url, hash: hash)
        XCTAssertEqual(try result.get(), bytes)
        XCTAssertEqual(cache.data(forHash: hash), bytes)
    }

    func testFetchRejectsABodyItDeclaresIsPastTheByteCap() async throws {
        let bytes = avatar(1)
        stubbedResponse.set(
            headerFields: ["Content-Length": "\(AvatarCache.maxBytes + 1)"],
            body: bytes
        )

        let url = try XCTUnwrap(URL(string: "https://storage.example.com/avatar.png"))
        let result = await cache.fetch(url: url, hash: AvatarCache.sha256Hex(bytes))
        XCTAssertEqual(result.reason, .declaredTooLarge)
        XCTAssertEqual(storedFileCount(), 0)
    }

    /// A response that declares no length is read under the streaming cap
    /// alone, which is the only thing standing between a lying host and the
    /// extension's memory budget.
    func testFetchRejectsAnUndeclaredBodyPastTheByteCap() async throws {
        let oversized = Data(repeating: 0x41, count: AvatarCache.maxBytes + 1)
        stubbedResponse.set(headerFields: [:], body: oversized)

        let url = try XCTUnwrap(URL(string: "https://storage.example.com/avatar.png"))
        let result = await cache.fetch(url: url, hash: AvatarCache.sha256Hex(oversized))
        XCTAssertEqual(result.reason, .bodyTooLarge)
        XCTAssertEqual(storedFileCount(), 0)
    }

    func testFetchRejectsANonOkStatus() async throws {
        let bytes = avatar(1)
        stubbedResponse.set(statusCode: 404, headerFields: [:], body: bytes)

        let url = try XCTUnwrap(URL(string: "https://storage.example.com/avatar.png"))
        let result = await cache.fetch(url: url, hash: AvatarCache.sha256Hex(bytes))
        XCTAssertEqual(result.reason, .badStatus)
        XCTAssertEqual(storedFileCount(), 0)
    }

    func testFetchRejectsBytesThatDoNotMatchTheHash() async throws {
        stubbedResponse.set(headerFields: [:], body: avatar(2))

        let url = try XCTUnwrap(URL(string: "https://storage.example.com/avatar.png"))
        let result = await cache.fetch(url: url, hash: AvatarCache.sha256Hex(avatar(1)))
        XCTAssertEqual(result.reason, .digestMismatch)
        XCTAssertEqual(storedFileCount(), 0)
    }
}

private extension Result where Failure == AvatarCache.UnavailableReason {
    /// The reason a fetch gave up, or `nil` when it succeeded.
    var reason: AvatarCache.UnavailableReason? {
        guard case .failure(let reason) = self else {
            return nil
        }
        return reason
    }
}

/// Counts the requests that reach the URL loading system, so a test can tell a
/// guard that returned early apart from a request that went out. Serves
/// ``stubbedResponse`` when one is set and fails the request otherwise, which
/// keeps the tests that assert on a failed request unchanged.
private final class CountingURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        loadCounter.increment()
        guard let url = request.url,
              let stub = stubbedResponse.current,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: stub.statusCode,
                  httpVersion: "HTTP/1.1",
                  headerFields: stub.headerFields
              )
        else {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Shared for the same reason ``loadCounter`` is.
private let stubbedResponse = StubbedResponse()

private final class StubbedResponse: @unchecked Sendable {
    struct Stub {
        let statusCode: Int
        let headerFields: [String: String]
        let body: Data
    }

    private let lock = NSLock()
    private var stub: Stub?

    var current: Stub? { lock.withLock { stub } }

    /// Headers with no `Content-Length` are what a chunked response looks like
    /// to `URLSession`: `expectedContentLength` comes back as -1.
    func set(statusCode: Int = 200, headerFields: [String: String], body: Data) {
        lock.withLock {
            stub = Stub(statusCode: statusCode, headerFields: headerFields, body: body)
        }
    }

    func clear() {
        lock.withLock { stub = nil }
    }
}

/// Shared because `URLProtocol` instances are created by the loading system,
/// which hands the test no reference to them.
private let loadCounter = LoadCounter()

private final class LoadCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    var count: Int { lock.withLock { value } }

    func increment() {
        lock.withLock { value += 1 }
    }

    func reset() {
        lock.withLock { value = 0 }
    }
}

/// A byte sequence that hands out one byte at a time and counts how many it was
/// asked for, so a test can assert that a reader stopped early. The default
/// `count` never runs out, and a `millisecondsPerByte` above zero paces the
/// bytes, so a feed with both stops only when its reader gives up.
private final class ByteFeed: @unchecked Sendable {
    private(set) var produced = 0
    private var remaining: Int
    private let millisecondsPerByte: Int

    init(count: Int = .max, millisecondsPerByte: Int = 0) {
        remaining = count
        self.millisecondsPerByte = millisecondsPerByte
    }

    func stream() -> AsyncStream<UInt8> {
        AsyncStream(unfolding: { await self.next() })
    }

    private func next() async -> UInt8? {
        if millisecondsPerByte > 0 {
            guard
                (try? await Task.sleep(
                    nanoseconds: UInt64(millisecondsPerByte) * 1_000_000
                )) != nil
            else {
                return nil
            }
        }
        guard remaining > 0 else {
            return nil
        }
        remaining -= 1
        produced += 1
        return 0x41
    }
}
