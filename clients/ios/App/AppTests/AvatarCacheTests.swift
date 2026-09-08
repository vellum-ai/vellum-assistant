import XCTest

final class AvatarCacheTests: XCTestCase {
    private var root: URL!
    private var cache: AvatarCache!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("AvatarCache-\(UUID().uuidString)", isDirectory: true)
        cache = AvatarCache(rootURL: root)
    }

    override func tearDown() {
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
}
