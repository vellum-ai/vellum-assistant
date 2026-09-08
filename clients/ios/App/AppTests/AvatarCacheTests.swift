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

    func testFetchRefusesANonHttpsURL() async throws {
        let url = try XCTUnwrap(URL(string: "http://storage.example.com/avatar.png"))
        let bytes = await cache.fetch(url: url, hash: AvatarCache.sha256Hex(avatar(1)))
        XCTAssertNil(bytes)
        XCTAssertEqual(loadCounter.count, 0)
    }

    func testFetchRefusesAMalformedHash() async throws {
        let url = try XCTUnwrap(URL(string: "https://storage.example.com/avatar.png"))
        let bytes = await cache.fetch(url: url, hash: "../etc/passwd")
        XCTAssertNil(bytes)
        XCTAssertEqual(loadCounter.count, 0)
    }

    /// Proves the two guards above are what stopped the request, rather than a
    /// stub that never intercepts: the same call with both guards satisfied
    /// does reach the URL loading system.
    func testFetchReachesTheNetworkOnceTheGuardsPass() async throws {
        let url = try XCTUnwrap(URL(string: "https://storage.example.com/avatar.png"))
        let bytes = await cache.fetch(url: url, hash: AvatarCache.sha256Hex(avatar(1)))
        XCTAssertNil(bytes)
        XCTAssertEqual(loadCounter.count, 1)
    }
}

/// Counts the requests that reach the URL loading system and fails every one of
/// them, so a test can tell a guard that returned early apart from a request
/// that went out and came back empty.
private final class CountingURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        loadCounter.increment()
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    }

    override func stopLoading() {}
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
/// asked for, so a test can assert that a reader stopped early.
private final class ByteFeed: @unchecked Sendable {
    private(set) var produced = 0
    private var remaining: Int

    init(count: Int) {
        remaining = count
    }

    func stream() -> AsyncStream<UInt8> {
        AsyncStream(unfolding: { self.next() })
    }

    private func next() -> UInt8? {
        guard remaining > 0 else {
            return nil
        }
        remaining -= 1
        produced += 1
        return 0x41
    }
}
