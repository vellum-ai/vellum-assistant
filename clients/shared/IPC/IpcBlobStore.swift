import Foundation
import CryptoKit
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "IpcBlobStore")

/// Resolve the IPC blob directory path, mirroring the daemon's `getIpcBlobDir()`.
/// The daemon derives its blob dir from `BASE_DATA_DIR` (or `$HOME`), so the
/// client must use the same root to ensure probe files land in the same directory.
///
/// Resolution: `(BASE_DATA_DIR || $HOME) / .vellum / workspace / data / ipc-blobs`
///
/// Returns a plain string path rather than a URL to avoid Foundation's URL
/// layer normalizing or expanding tildes (both `URL(fileURLWithPath:)` and
/// `appendingPathComponent` can do this). Plain string concatenation matches
/// the daemon's `path.join()` behavior exactly.
func resolveBlobDir(environment: [String: String]? = nil) -> String {
    let env = environment ?? ProcessInfo.processInfo.environment
    let root: String
    if let baseDataDir = env["BASE_DATA_DIR"], !baseDataDir.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        root = baseDataDir.trimmingCharacters(in: .whitespacesAndNewlines)
    } else {
        root = NSHomeDirectory()
    }
    return root + "/.vellum/workspace/data/ipc-blobs"
}

/// Manages local blob files for zero-copy IPC transport.
/// Blobs are written atomically (temp file + rename) to the directory resolved
/// by `resolveBlobDir()`, which honors the `BASE_DATA_DIR` environment variable.
/// All file I/O uses `FileManager` string-path APIs to avoid Foundation's URL
/// layer expanding tildes in paths derived from `BASE_DATA_DIR`.
public final class IpcBlobStore: Sendable {
    public static let shared = IpcBlobStore()

    private let blobDirPath: String

    /// Creates a blob store using the directory resolved from `BASE_DATA_DIR` / `$HOME`.
    private init() {
        blobDirPath = resolveBlobDir()
    }

    /// Creates a blob store targeting a specific directory (for testing).
    init(blobDir: URL) {
        self.blobDirPath = blobDir.path
    }

    /// Creates a blob store targeting a specific directory path (for testing).
    init(blobDirPath: String) {
        self.blobDirPath = blobDirPath
    }

    /// Ensure the blob directory exists.
    public func ensureDirectory() {
        do {
            try FileManager.default.createDirectory(
                atPath: blobDirPath,
                withIntermediateDirectories: true,
                attributes: nil
            )
        } catch {
            log.error("Failed to create blob directory at \(self.blobDirPath): \(error)")
        }
    }

    /// Write data atomically to a blob file and return a ref describing the blob.
    /// Uses temp file + rename to guarantee readers never see partial writes.
    public func writeBlob(data: Data, kind: String, encoding: String) -> IPCIpcBlobRef? {
        let id = UUID().uuidString.lowercased()
        let targetPath = blobDirPath + "/\(id).blob"
        let tempPath = blobDirPath + "/\(id).tmp"

        do {
            guard FileManager.default.createFile(atPath: tempPath, contents: data) else {
                throw NSError(domain: "IpcBlobStore", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "createFile failed for \(tempPath)"
                ])
            }
            try FileManager.default.moveItem(atPath: tempPath, toPath: targetPath)

            let sha256 = Self.computeSHA256(data: data)

            return IPCIpcBlobRef(
                id: id,
                kind: kind,
                encoding: encoding,
                byteLength: data.count,
                sha256: sha256
            )
        } catch {
            log.error("Failed to write blob \(id): \(error.localizedDescription)")
            do {
                try FileManager.default.removeItem(atPath: tempPath)
            } catch {
                log.error("Failed to clean up temp blob file at \(tempPath): \(error)")
            }
            return nil
        }
    }

    /// Write a probe file containing random nonce bytes and return the probe ID
    /// and SHA-256 of the nonce. The daemon reads the file, hashes it, and replies
    /// with its observed hash so the client can verify filesystem-level reachability.
    public func writeProbeFile() -> (probeId: String, nonceSha256: String)? {
        let probeId = UUID().uuidString.lowercased()
        let targetPath = blobDirPath + "/\(probeId).blob"

        var nonce = Data(count: 32)
        let result = nonce.withUnsafeMutableBytes { ptr in
            SecRandomCopyBytes(kSecRandomDefault, 32, ptr.baseAddress!)
        }
        guard result == errSecSuccess else {
            log.error("Failed to generate random nonce for probe")
            return nil
        }

        guard FileManager.default.createFile(atPath: targetPath, contents: nonce) else {
            log.error("Failed to write probe file \(probeId)")
            return nil
        }
        let sha256 = Self.computeSHA256(data: nonce)
        return (probeId: probeId, nonceSha256: sha256)
    }

    private static func computeSHA256(data: Data) -> String {
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
