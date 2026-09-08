import CryptoKit
import Foundation

/// Disk cache of notification avatar PNGs, keyed by the SHA-256 hex digest the
/// push carries.
///
/// It lives in the App Group container so the cache survives the extension
/// process, which iOS starts and kills per push: a second notification for the
/// same avatar renders without touching the network. Content addressing makes
/// invalidation implicit, so a new avatar on the assistant is a new hash and a
/// new file.
///
/// Only 64-character lowercase hex hashes are accepted, which both rejects a
/// malformed payload and keeps the hash safe to use as a filename. Bytes are
/// hashed before they are stored, so a truncated or substituted download never
/// reaches the notification.
struct AvatarCache {
    static let directoryName = "notification-avatars"
    /// Kept small on purpose: one entry per assistant avatar the user has seen
    /// recently, in a container shared with the app's own data.
    static let maxEntries = 8
    static let maxBytes = 512 * 1024
    static let defaultTimeout: TimeInterval = 8
    static let readChunkSize = 16 * 1024

    let rootURL: URL

    /// The cache inside this bundle's App Group container, or `nil` when the
    /// bundle declares no group and there is nowhere shared to write.
    static func inAppGroup() -> AvatarCache? {
        guard let group = AppGroupID.current,
              let container = FileManager.default
                  .containerURL(forSecurityApplicationGroupIdentifier: group)
        else {
            return nil
        }
        return AvatarCache(
            rootURL: container
                .appendingPathComponent("Library/Caches", isDirectory: true)
                .appendingPathComponent(directoryName, isDirectory: true)
        )
    }

    /// The cached bytes for `hash`, or `nil` when nothing is stored under it.
    ///
    /// The bytes are re-hashed on the way out, not only on the way in: the
    /// container is shared with the app, and a file that no longer matches its
    /// own name is deleted rather than rendered.
    ///
    /// A hit stamps the file with the current time so eviction, which ranks by
    /// modification date, treats a recently used avatar as recent.
    func data(forHash hash: String) -> Data? {
        guard let url = fileURL(forHash: hash), let data = try? Data(contentsOf: url) else {
            return nil
        }
        guard Self.sha256Hex(data) == hash else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        try? FileManager.default.setAttributes(
            [.modificationDate: Date()],
            ofItemAtPath: url.path
        )
        return data
    }

    /// Store `data` under `hash`, or do nothing when the bytes do not hash to
    /// it. Evicts the oldest entries down to ``maxEntries``.
    func store(_ data: Data, hash: String) {
        guard let url = fileURL(forHash: hash), Self.sha256Hex(data) == hash else {
            return
        }
        do {
            try FileManager.default.createDirectory(
                at: rootURL,
                withIntermediateDirectories: true
            )
            try data.write(to: url, options: .atomic)
        } catch {
            return
        }
        evictOldest()
    }

    /// Download the avatar at `url`, verify it against `hash`, cache it, and
    /// return the bytes. Any failure returns `nil` and the caller delivers the
    /// notification unchanged.
    ///
    /// The URL arrives in the push payload, so only `https` is followed and only
    /// bytes that hash to `hash` are used. A response that declares no length or
    /// one past ``maxBytes`` is dropped before its body is read, and the body
    /// itself is abandoned the moment it goes past the same cap, which keeps an
    /// oversized or malformed response from filling the extension's memory
    /// budget. `timeout` bounds how long the read may take.
    func fetch(url: URL, hash: String, timeout: TimeInterval = defaultTimeout) async -> Data? {
        guard Self.isValidHash(hash), url.scheme == "https" else {
            return nil
        }
        let request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: timeout
        )
        guard let (bytes, response) = try? await URLSession.shared.bytes(for: request) else {
            return nil
        }
        guard let http = response as? HTTPURLResponse,
              http.statusCode == 200,
              http.expectedContentLength >= 0,
              http.expectedContentLength <= Int64(Self.maxBytes)
        else {
            bytes.task.cancel()
            return nil
        }
        guard let data = try? await Self.readAtMost(Self.maxBytes, from: bytes),
              Self.sha256Hex(data) == hash
        else {
            bytes.task.cancel()
            return nil
        }
        store(data, hash: hash)
        return data
    }

    /// Collect `bytes` until the sequence ends, or return `nil` as soon as more
    /// than `limit` bytes arrive so an oversized body is never held whole.
    ///
    /// Bytes land in an array first and reach the `Data` a chunk at a time:
    /// appending each byte to `Data` individually costs a bounds check and a
    /// possible reallocation per byte, which is the whole of the extension's
    /// CPU budget on a 512 KB avatar.
    static func readAtMost<Bytes: AsyncSequence>(
        _ limit: Int,
        from bytes: Bytes
    ) async throws -> Data? where Bytes.Element == UInt8 {
        var data = Data()
        data.reserveCapacity(min(limit, readChunkSize))
        var chunk = [UInt8]()
        chunk.reserveCapacity(min(limit, readChunkSize))
        for try await byte in bytes {
            if data.count + chunk.count >= limit {
                return nil
            }
            chunk.append(byte)
            if chunk.count == readChunkSize {
                data.append(contentsOf: chunk)
                chunk.removeAll(keepingCapacity: true)
            }
        }
        data.append(contentsOf: chunk)
        return data
    }

    func fileURL(forHash hash: String) -> URL? {
        guard Self.isValidHash(hash) else {
            return nil
        }
        return rootURL.appendingPathComponent("\(hash).png", isDirectory: false)
    }

    static func isValidHash(_ hash: String) -> Bool {
        hash.count == 64 && hash.allSatisfy { hexDigits.contains($0) }
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static let hexDigits = Set("0123456789abcdef")

    private func evictOldest() {
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: rootURL,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        guard entries.count > Self.maxEntries else {
            return
        }
        let oldestFirst = entries.sorted { lhs, rhs in
            modificationDate(of: lhs) < modificationDate(of: rhs)
        }
        for url in oldestFirst.prefix(entries.count - Self.maxEntries) {
            try? FileManager.default.removeItem(at: url)
        }
    }

    private func modificationDate(of url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey])
            .contentModificationDate) ?? .distantPast
    }
}
