import XCTest
import CryptoKit
@testable import VellumAssistantShared

final class IpcBlobStoreTests: XCTestCase {

    private var tempDir: URL!
    private var blobStore: IpcBlobStore!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        blobStore = IpcBlobStore(blobDir: tempDir)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        super.tearDown()
    }

    // MARK: - writeBlob

    func testWriteBlobReturnsRefWithCorrectMetadata() {
        let data = Data("Hello, blob!".utf8)
        let ref = blobStore.writeBlob(data: data, kind: "ax_tree", encoding: "utf8")

        XCTAssertNotNil(ref)
        XCTAssertEqual(ref?.kind, "ax_tree")
        XCTAssertEqual(ref?.encoding, "utf8")
        XCTAssertEqual(ref?.byteLength, data.count)
        XCTAssertNotNil(ref?.sha256)
        XCTAssertFalse(ref!.id.isEmpty)
    }

    func testWriteBlobCreatesBlobFile() {
        let data = Data("test content".utf8)
        let ref = blobStore.writeBlob(data: data, kind: "screenshot_jpeg", encoding: "binary")

        XCTAssertNotNil(ref)
        let blobPath = tempDir.appendingPathComponent("\(ref!.id).blob").path
        XCTAssertTrue(FileManager.default.fileExists(atPath: blobPath))
    }

    func testWriteBlobSHA256MatchesExpected() {
        let data = Data("verify hash".utf8)
        let ref = blobStore.writeBlob(data: data, kind: "ax_tree", encoding: "utf8")

        let expectedHash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(ref?.sha256, expectedHash)
    }

    func testWriteBlobAtomicNoTempFileLeft() {
        let data = Data("atomic write".utf8)
        let ref = blobStore.writeBlob(data: data, kind: "ax_tree", encoding: "utf8")

        XCTAssertNotNil(ref)
        // No .tmp file should remain
        let tmpPath = tempDir.appendingPathComponent("\(ref!.id).tmp").path
        XCTAssertFalse(FileManager.default.fileExists(atPath: tmpPath))
    }

    func testWriteBlobFileContentsMatchInput() throws {
        let data = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
        let ref = blobStore.writeBlob(data: data, kind: "screenshot_jpeg", encoding: "binary")

        XCTAssertNotNil(ref)
        let blobPath = tempDir.appendingPathComponent("\(ref!.id).blob")
        let readBack = try Data(contentsOf: blobPath)
        XCTAssertEqual(readBack, data)
    }

    // MARK: - writeProbeFile

    func testWriteProbeFileReturnsProbeIdAndHash() {
        let result = blobStore.writeProbeFile()

        XCTAssertNotNil(result)
        XCTAssertFalse(result!.probeId.isEmpty)
        XCTAssertFalse(result!.nonceSha256.isEmpty)
        // SHA-256 hex is always 64 characters
        XCTAssertEqual(result!.nonceSha256.count, 64)
    }

    func testWriteProbeFileCreatesFile() {
        let result = blobStore.writeProbeFile()

        XCTAssertNotNil(result)
        let probePath = tempDir.appendingPathComponent("\(result!.probeId).blob").path
        XCTAssertTrue(FileManager.default.fileExists(atPath: probePath))
    }

    func testWriteProbeFileHashMatchesFileContents() throws {
        let result = blobStore.writeProbeFile()

        XCTAssertNotNil(result)
        let probePath = tempDir.appendingPathComponent("\(result!.probeId).blob")
        let fileData = try Data(contentsOf: probePath)

        let expectedHash = SHA256.hash(data: fileData).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(result!.nonceSha256, expectedHash)
    }

    func testWriteProbeFileNonceIs32Bytes() throws {
        let result = blobStore.writeProbeFile()

        XCTAssertNotNil(result)
        let probePath = tempDir.appendingPathComponent("\(result!.probeId).blob")
        let fileData = try Data(contentsOf: probePath)
        XCTAssertEqual(fileData.count, 32)
    }

    // MARK: - resolveBlobDir
    // Baseline: blob dir currently resolves under ~/.vellum/data/ipc-blobs.
    // WILL MOVE to ~/.vellum/workspace/data/ipc-blobs after workspace migration.

    func testResolveBlobDirDefaultsToHomeDotVellum() {
        let resolved = resolveBlobDir(environment: [:])
        let home = NSHomeDirectory()
        XCTAssertEqual(resolved, home + "/.vellum/data/ipc-blobs")
    }

    func testResolveBlobDirHonorsBaseDataDir() {
        let resolved = resolveBlobDir(environment: ["BASE_DATA_DIR": "/tmp/custom-root"])
        XCTAssertEqual(resolved, "/tmp/custom-root/.vellum/data/ipc-blobs")
    }

    func testResolveBlobDirIgnoresEmptyBaseDataDir() {
        let resolved = resolveBlobDir(environment: ["BASE_DATA_DIR": "  "])
        let home = NSHomeDirectory()
        XCTAssertEqual(resolved, home + "/.vellum/data/ipc-blobs")
    }

    func testResolveBlobDirDoesNotExpandTildeInBaseDataDir() {
        // The daemon's getRootDir() keeps BASE_DATA_DIR literal via path.join(),
        // so the Swift client must NOT expand "~/" either.
        let resolved = resolveBlobDir(environment: ["BASE_DATA_DIR": "~/custom"])
        XCTAssertEqual(resolved, "~/custom/.vellum/data/ipc-blobs")
        XCTAssertFalse(resolved.contains(NSHomeDirectory()), "home dir should NOT appear in path")
    }

}
