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
    static let requestTimeout: TimeInterval = 8
    /// The total wall-clock bound on one download. ``requestTimeout`` bounds
    /// only how long a transfer may stall without new bytes, so without this a
    /// host trickling a byte at a time would run until the extension's own
    /// budget expired.
    static let downloadBudget: TimeInterval = 6
    static let readChunkSize = 16 * 1024

    /// Why no avatar reached the notification. Every cause has its own stable
    /// token, so the Console line names which one it was instead of standing
    /// for any of them.
    enum UnavailableReason: String, Error {
        case missingURL = "no_url"
        case invalidURL = "invalid_url"
        case badHash = "bad_hash"
        case insecureURL = "insecure_url"
        case requestFailed = "request_failed"
        case badStatus = "bad_status"
        case declaredTooLarge = "declared_too_large"
        case bodyTooLarge = "body_too_large"
        case readFailed = "read_failed"
        case timedOut = "timed_out"
        case digestMismatch = "digest_mismatch"
    }

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
    /// The container is shared with the app, so a stored file is held to the
    /// same bounds a download is: only a regular file is read, its size is read
    /// before its bytes, anything past ``maxBytes`` is deleted unread, and a
    /// file that no longer matches its own name is deleted rather than
    /// rendered.
    ///
    /// A hit stamps the file with the current time so eviction, which ranks by
    /// modification date, treats a recently used avatar as recent.
    func data(forHash hash: String) -> Data? {
        guard let url = fileURL(forHash: hash),
              let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        else {
            return nil
        }
        // `attributesOfItem` describes a symlink itself while `Data(contentsOf:)`
        // follows it, so a link reports the wrong size and the cap bounds
        // nothing. Anything that is not a regular file is poisoned.
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? Int,
              size <= Self.maxBytes
        else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        guard let data = try? Data(contentsOf: url) else {
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
    /// return the bytes. Any failure returns the reason it gave up instead, and
    /// the caller delivers the notification unchanged.
    ///
    /// The URL arrives in the push payload, so only `https` is followed and only
    /// bytes that hash to `hash` are used. A response declaring a length past
    /// ``maxBytes`` is dropped before its body is read; a response declaring no
    /// length at all, as a chunked one does, is read under the same cap and
    /// abandoned the moment it crosses it. The streaming cap, not the declared
    /// length, is what keeps an oversized or malformed response out of the
    /// extension's memory budget.
    ///
    /// ``requestTimeout`` is the request's idle timeout: it bounds how long the
    /// transfer may stall without new bytes, not how long it may run in total.
    /// ``downloadBudget`` is the total bound, which a body arriving slowly
    /// enough crosses without ever going idle; it surfaces as `timed_out`.
    func fetch(url: URL, hash: String) async -> Result<Data, UnavailableReason> {
        guard Self.isValidHash(hash) else {
            return .failure(.badHash)
        }
        guard url.scheme == "https" else {
            return .failure(.insecureURL)
        }
        let request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: Self.requestTimeout
        )
        guard let (bytes, response) = try? await URLSession.shared.bytes(for: request) else {
            return .failure(.requestFailed)
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            bytes.task.cancel()
            return .failure(.badStatus)
        }
        // A response that declares no length reports NSURLResponseUnknownLength,
        // which is negative and so passes this cap on its way to the streaming
        // one.
        let declared = http.expectedContentLength
        guard declared <= Int64(Self.maxBytes) else {
            bytes.task.cancel()
            return .failure(.declaredTooLarge)
        }
        let body: Data?
        do {
            body = try await Self.readAtMost(
                Self.maxBytes,
                from: bytes,
                expecting: declared >= 0 ? Int(declared) : nil
            )
        } catch let reason as UnavailableReason {
            bytes.task.cancel()
            return .failure(reason)
        } catch {
            bytes.task.cancel()
            return .failure(.readFailed)
        }
        guard let data = body else {
            bytes.task.cancel()
            return .failure(.bodyTooLarge)
        }
        guard Self.sha256Hex(data) == hash else {
            return .failure(.digestMismatch)
        }
        store(data, hash: hash)
        return .success(data)
    }

    /// Collect `bytes` until the sequence ends, or return `nil` as soon as more
    /// than `limit` bytes arrive so an oversized body is never held whole.
    ///
    /// `expectedCount` is the length the response declared, when it declared
    /// one, so a known-size body is reserved for once instead of growing into
    /// place. Bytes land in a preallocated buffer and reach the `Data` a chunk
    /// at a time: appending each byte to `Data` on its own costs a bounds check
    /// and a possible reallocation per byte, which is the whole of the
    /// extension's CPU budget on a 512 KB avatar.
    ///
    /// Throws ``UnavailableReason/timedOut`` once `budget` is spent, so a body
    /// that keeps arriving too slowly to go idle is still bounded.
    ///
    /// The clock is read once per byte against a monotonic deadline. Any stride
    /// between checks is a window a trickle hides in: a host answering fewer
    /// bytes than the stride, however slowly, would never reach a check at all.
    /// A full 512 KB body pays for one clock read per byte, tens of
    /// milliseconds against a six-second budget.
    static func readAtMost<Bytes: AsyncSequence>(
        _ limit: Int,
        from bytes: Bytes,
        expecting expectedCount: Int? = nil,
        within budget: Duration = .seconds(downloadBudget)
    ) async throws -> Data? where Bytes.Element == UInt8 {
        let deadline = ContinuousClock.now + budget
        var data = Data()
        data.reserveCapacity(min(limit, expectedCount ?? readChunkSize))
        var chunk = [UInt8](repeating: 0, count: min(limit, readChunkSize))
        var filled = 0
        for try await byte in bytes {
            if data.count + filled >= limit {
                return nil
            }
            guard ContinuousClock.now < deadline else {
                throw UnavailableReason.timedOut
            }
            chunk[filled] = byte
            filled += 1
            if filled == chunk.count {
                data.append(contentsOf: chunk)
                filled = 0
            }
        }
        data.append(contentsOf: chunk[0..<filled])
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
