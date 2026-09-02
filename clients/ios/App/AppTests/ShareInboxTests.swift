import XCTest

final class ShareInboxTests: XCTestCase {
    private var container: URL!
    private var exportDir: URL!

    override func setUp() {
        super.setUp()
        container = FileManager.default.temporaryDirectory
            .appendingPathComponent("ShareInbox-\(UUID().uuidString)", isDirectory: true)
        exportDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("ShareInboxExport-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: container)
        try? FileManager.default.removeItem(at: exportDir)
        super.tearDown()
    }

    func testExportKeepsSameNamedFilesOnDistinctPaths() throws {
        let first = Data("one".utf8)
        let second = Data("two".utf8)
        let id = ShareInbox.write(
            destination: .newConversation,
            text: nil,
            files: [
                (filename: "photo.jpg", mimeType: "image/jpeg", data: first),
                (filename: "photo.jpg", mimeType: "image/jpeg", data: second),
            ],
            containerURL: container
        )
        XCTAssertNotNil(id)
        let consumed = ShareInbox.consume(
            id: id!,
            exportDirectory: exportDir,
            containerURL: container
        )
        XCTAssertEqual(consumed?.files.count, 2)
        let paths = consumed?.files.map(\.path) ?? []
        XCTAssertEqual(Set(paths).count, 2)
        let bodies = try paths.map { try Data(contentsOf: URL(fileURLWithPath: $0)) }
        XCTAssertEqual(Set(bodies), [first, second])
        XCTAssertEqual(consumed?.files.map(\.filename), ["photo.jpg", "photo.jpg"])
    }

    func testWriteAndConsumeCopiesFilesThenDeletesInbox() throws {
        let bytes = Data("hello".utf8)
        let id = ShareInbox.write(
            destination: .newConversation,
            text: "a note",
            files: [(filename: "note.txt", mimeType: "text/plain", data: bytes)],
            containerURL: container
        )
        XCTAssertNotNil(id)
        let itemDir = container.appendingPathComponent(id!, isDirectory: true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: itemDir.path))

        let consumed = ShareInbox.consume(
            id: id!,
            exportDirectory: exportDir,
            containerURL: container
        )
        XCTAssertEqual(consumed?.destination, .newConversation)
        XCTAssertEqual(consumed?.text, "a note")
        XCTAssertEqual(consumed?.files.count, 1)
        XCTAssertEqual(consumed?.files.first?.filename, "note.txt")
        XCTAssertEqual(consumed?.files.first?.mimeType, "text/plain")
        let exported = try Data(contentsOf: URL(fileURLWithPath: consumed!.files[0].path))
        XCTAssertEqual(exported, bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: itemDir.path))

        XCTAssertNil(
            ShareInbox.consume(
                id: id!,
                exportDirectory: exportDir,
                containerURL: container
            )
        )
    }

    func testWriteRejectsEmptyPayload() {
        XCTAssertNil(
            ShareInbox.write(
                destination: .newConversation,
                text: "   ",
                files: [],
                containerURL: container
            )
        )
    }

    func testDestinationThreadRoundTrips() {
        let id = ShareInbox.write(
            destination: .thread(id: "conv-xyz"),
            text: "hello",
            files: [],
            containerURL: container
        )
        let consumed = ShareInbox.consume(
            id: id!,
            exportDirectory: exportDir,
            containerURL: container
        )
        XCTAssertEqual(consumed?.destination, .thread(id: "conv-xyz"))
    }

    func testConsumeRejectsPathTraversalId() {
        XCTAssertNil(
            ShareInbox.consume(
                id: "../etc",
                exportDirectory: exportDir,
                containerURL: container
            )
        )
        XCTAssertNil(
            ShareInbox.consume(
                id: "abc/def",
                exportDirectory: exportDir,
                containerURL: container
            )
        )
    }

    func testExpiredItemIsAbsentAndSwept() {
        let created = Date().addingTimeInterval(-(ShareInbox.ttl + 1))
        let id = ShareInbox.write(
            destination: .newConversation,
            text: "stale",
            files: [],
            containerURL: container,
            now: created
        )
        XCTAssertNil(
            ShareInbox.consume(
                id: id!,
                exportDirectory: exportDir,
                containerURL: container,
                now: Date()
            )
        )
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: container.appendingPathComponent(id!, isDirectory: true).path
            )
        )
    }

    func testConsumeLatestTakesNewest() {
        let older = ShareInbox.write(
            destination: .newConversation,
            text: "first",
            files: [],
            containerURL: container
        )
        let newer = ShareInbox.write(
            destination: .thread(id: "conv-xyz"),
            text: "second",
            files: [],
            containerURL: container
        )
        XCTAssertNotEqual(older, newer)
        let consumed = ShareInbox.consumeLatest(
            exportDirectory: exportDir,
            containerURL: container
        )
        XCTAssertEqual(consumed?.text, "second")
        XCTAssertEqual(consumed?.destination, .thread(id: "conv-xyz"))
        XCTAssertEqual(
            ShareInbox.consume(
                id: older!,
                exportDirectory: exportDir,
                containerURL: container
            )?.text,
            "first"
        )
    }

    func testSanitizedFilenameStripsSeparatorsAndClips() {
        XCTAssertEqual(ShareInbox.sanitizedFilename("../../secret.txt"), "secret.txt")
        XCTAssertEqual(ShareInbox.sanitizedFilename(""), "attachment")
        let long = String(repeating: "a", count: 250) + ".png"
        let clipped = ShareInbox.sanitizedFilename(long)
        XCTAssertLessThanOrEqual(clipped.count, 200)
        XCTAssertTrue(clipped.hasSuffix(".png"))
    }

    func testSafeItemIdAcceptsUUIDsOnly() {
        XCTAssertTrue(ShareInbox.isSafeItemId("A1B2C3D4-E5F6-7890-ABCD-EF1234567890"))
        XCTAssertFalse(ShareInbox.isSafeItemId(""))
        XCTAssertFalse(ShareInbox.isSafeItemId("../x"))
        XCTAssertFalse(ShareInbox.isSafeItemId(String(repeating: "a", count: 65)))
    }

    func testFileURLRejectsTraversal() {
        let id = "item-123"
        let file = ShareInboxFile(
            filename: "x",
            mimeType: "text/plain",
            relativePath: "files/../manifest.json"
        )
        XCTAssertNil(ShareInbox.fileURL(for: file, itemId: id, containerURL: container))
    }
}

final class ShareDeepLinkTests: XCTestCase {
    func testBuildsShareHostURL() {
        let url = ShareDeepLink(inboxId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890")
            .url(scheme: "vellum-assistant")
        XCTAssertEqual(
            url?.absoluteString,
            "vellum-assistant://share/A1B2C3D4-E5F6-7890-ABCD-EF1234567890"
        )
    }

    func testRejectsUnsafeId() {
        XCTAssertNil(ShareDeepLink(inboxId: "../x").url(scheme: "vellum-assistant"))
        XCTAssertNil(ShareDeepLink(inboxId: "ok").url(scheme: nil))
    }
}

final class RecentChatsStoreTests: XCTestCase {
    func testMigratesLegacyStandardSuiteIntoAppGroup() {
        let group = UserDefaults(suiteName: "ai.vellum.assistant.AppTests.recent.\(UUID().uuidString)")!
        let chats = [RecentChat(id: "conv-xyz", title: "Gym")]
        let encoded = try! JSONEncoder().encode(chats)
        UserDefaults.standard.set(encoded, forKey: RecentChatsStore.defaultsKey)
        defer {
            UserDefaults.standard.removeObject(forKey: RecentChatsStore.defaultsKey)
        }

        let loaded = RecentChatsStore.load(defaults: group)
        XCTAssertEqual(loaded, chats)
        XCTAssertNil(UserDefaults.standard.data(forKey: RecentChatsStore.defaultsKey))
        XCTAssertEqual(RecentChatsStore.load(defaults: group), chats)
    }

    func testSaveDropsLegacyStandardCopy() {
        let group = UserDefaults(suiteName: "ai.vellum.assistant.AppTests.recent.\(UUID().uuidString)")!
        UserDefaults.standard.set(Data([1, 2, 3]), forKey: RecentChatsStore.defaultsKey)
        defer {
            UserDefaults.standard.removeObject(forKey: RecentChatsStore.defaultsKey)
        }
        RecentChatsStore.save([RecentChat(id: "conv-xyz", title: "Notes")], defaults: group)
        XCTAssertNil(UserDefaults.standard.data(forKey: RecentChatsStore.defaultsKey))
        XCTAssertEqual(RecentChatsStore.load(defaults: group).first?.id, "conv-xyz")
    }
}
