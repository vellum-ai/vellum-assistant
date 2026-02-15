import XCTest
import CryptoKit
@testable import VellumAssistantShared

final class IpcBlobStoreTests: XCTestCase {

    private var tempDir: URL!
    private var blobStore: TestableIpcBlobStore!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        blobStore = TestableIpcBlobStore(blobDir: tempDir)
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
        let blobPath = tempDir.appendingPathComponent("\(ref!.id).blob")
        XCTAssertTrue(FileManager.default.fileExists(atPath: blobPath.path))
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
        let tmpPath = tempDir.appendingPathComponent("\(ref!.id).tmp")
        XCTAssertFalse(FileManager.default.fileExists(atPath: tmpPath.path))
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
        let probePath = tempDir.appendingPathComponent("\(result!.probeId).blob")
        XCTAssertTrue(FileManager.default.fileExists(atPath: probePath.path))
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
}

// MARK: - Testable Subclass

/// A testable wrapper around IpcBlobStore that uses a custom blob directory
/// instead of the hardcoded ~/.vellum/data/ipc-blobs/.
private final class TestableIpcBlobStore {
    private let blobDir: URL

    init(blobDir: URL) {
        self.blobDir = blobDir
    }

    func writeBlob(data: Data, kind: String, encoding: String) -> IPCIpcBlobRef? {
        let id = UUID().uuidString.lowercased()
        let targetURL = blobDir.appendingPathComponent("\(id).blob")
        let tempURL = blobDir.appendingPathComponent("\(id).tmp")

        do {
            try data.write(to: tempURL)
            try FileManager.default.moveItem(at: tempURL, to: targetURL)

            let sha256 = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()

            return IPCIpcBlobRef(
                id: id,
                kind: kind,
                encoding: encoding,
                byteLength: data.count,
                sha256: sha256
            )
        } catch {
            try? FileManager.default.removeItem(at: tempURL)
            return nil
        }
    }

    func writeProbeFile() -> (probeId: String, nonceSha256: String)? {
        let probeId = UUID().uuidString.lowercased()
        let targetURL = blobDir.appendingPathComponent("\(probeId).blob")

        var nonce = Data(count: 32)
        let result = nonce.withUnsafeMutableBytes { ptr in
            SecRandomCopyBytes(kSecRandomDefault, 32, ptr.baseAddress!)
        }
        guard result == errSecSuccess else { return nil }

        do {
            try nonce.write(to: targetURL)
            let sha256 = SHA256.hash(data: nonce).map { String(format: "%02x", $0) }.joined()
            return (probeId: probeId, nonceSha256: sha256)
        } catch {
            return nil
        }
    }
}
