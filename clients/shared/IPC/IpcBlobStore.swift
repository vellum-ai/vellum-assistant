import Foundation
import CryptoKit
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "IpcBlobStore")

/// Manages local blob files for zero-copy IPC transport.
/// Blobs are written atomically (temp file + rename) to ~/.vellum/data/ipc-blobs/.
public final class IpcBlobStore: Sendable {
    public static let shared = IpcBlobStore()

    private let blobDir: URL

    private init() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        blobDir = home.appendingPathComponent(".vellum/data/ipc-blobs", isDirectory: true)
    }

    /// Ensure the blob directory exists.
    public func ensureDirectory() {
        try? FileManager.default.createDirectory(at: blobDir, withIntermediateDirectories: true)
    }

    /// Write data atomically to a blob file and return a ref describing the blob.
    /// Uses temp file + rename to guarantee readers never see partial writes.
    public func writeBlob(data: Data, kind: String, encoding: String) -> IPCIpcBlobRef? {
        let id = UUID().uuidString.lowercased()
        let targetURL = blobDir.appendingPathComponent("\(id).blob")
        let tempURL = blobDir.appendingPathComponent("\(id).tmp")

        do {
            try data.write(to: tempURL)
            try FileManager.default.moveItem(at: tempURL, to: targetURL)

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
            try? FileManager.default.removeItem(at: tempURL)
            return nil
        }
    }

    /// Write a probe file containing random nonce bytes and return the probe ID
    /// and SHA-256 of the nonce. The daemon reads the file, hashes it, and replies
    /// with its observed hash so the client can verify filesystem-level reachability.
    public func writeProbeFile() -> (probeId: String, nonceSha256: String)? {
        let probeId = UUID().uuidString.lowercased()
        let targetURL = blobDir.appendingPathComponent("\(probeId).blob")

        var nonce = Data(count: 32)
        let result = nonce.withUnsafeMutableBytes { ptr in
            SecRandomCopyBytes(kSecRandomDefault, 32, ptr.baseAddress!)
        }
        guard result == errSecSuccess else {
            log.error("Failed to generate random nonce for probe")
            return nil
        }

        do {
            try nonce.write(to: targetURL)
            let sha256 = Self.computeSHA256(data: nonce)
            return (probeId: probeId, nonceSha256: sha256)
        } catch {
            log.error("Failed to write probe file \(probeId): \(error.localizedDescription)")
            return nil
        }
    }

    private static func computeSHA256(data: Data) -> String {
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
