import Foundation

/// One file copied into a share-inbox item. `relativePath` is under that
/// item's directory; the host plugin turns it into an absolute path the
/// web layer can read.
struct ShareInboxFile: Codable, Equatable {
    let filename: String
    let mimeType: String
    let relativePath: String
}

/// Where a share-inbox item should land once the host app consumes it.
enum ShareInboxDestination: Codable, Equatable {
    case newConversation
    case thread(id: String)

    enum CodingKeys: String, CodingKey {
        case type
        case threadId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "new":
            self = .newConversation
        case "thread":
            let threadId = try container.decode(String.self, forKey: .threadId)
            self = .thread(id: threadId)
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown share destination"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .newConversation:
            try container.encode("new", forKey: .type)
        case .thread(let id):
            try container.encode("thread", forKey: .type)
            try container.encode(id, forKey: .threadId)
        }
    }
}

/// The payload the share extension writes and the host app consumes once.
///
/// Content lives in the App Group rather than on the command URL because a
/// custom scheme cannot carry file bytes, and because only this app and its
/// extensions can write the container. Finding a fresh item here is the
/// proof that the user shared through Vellum, which is why the web layer
/// may send on the user's behalf without the `src=intent` marker.
struct ShareInboxItem: Codable, Equatable {
    static let currentSchemaVersion = 1

    let schemaVersion: Int
    let id: String
    let createdAt: Date
    let destination: ShareInboxDestination
    let text: String?
    let files: [ShareInboxFile]
}

/// A file copied out of the inbox into the host's cache so the web layer
/// can read it after the inbox item is deleted.
struct ShareInboxExportedFile: Equatable {
    let filename: String
    let mimeType: String
    let path: String
}

/// One consumed share: destination, text, and files already copied out of
/// the App Group inbox.
struct ShareInboxConsumption: Equatable {
    let id: String
    let destination: ShareInboxDestination
    let text: String?
    let files: [ShareInboxExportedFile]
}

/// App Group directory of pending share payloads.
///
/// One item per share. `write` creates a fresh id directory (manifest plus
/// copied files). `consume` returns that item and deletes the directory, so
/// a payload is acted on at most once. Items older than ``ttl`` are treated
/// as absent and swept.
///
/// `containerURL` is injectable so unit tests can use a temp directory
/// instead of an App Group the test host does not have.
enum ShareInbox {
    static let directoryName = "ShareInbox"
    static let manifestName = "manifest.json"
    static let filesDirectoryName = "files"
    static let ttl: TimeInterval = 5 * 60
    static let maxFiles = 10
    static let maxFileBytes = 50 * 1024 * 1024
    static let maxTextLength = 32_000

    /// Darwin notification the share extension posts after a successful
    /// write, so a host already in memory can drain the inbox without
    /// waiting for the command URL.
    static let readyNotificationName = "ai.vellum.share-inbox-ready" as CFString

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    static func defaultContainerURL() -> URL? {
        guard let group = AppGroupID.current else {
            return nil
        }
        return FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: group)?
            .appendingPathComponent(directoryName, isDirectory: true)
    }

    /// Write `text` and `files` as a new inbox item. Returns the item id, or
    /// `nil` when the container cannot be created or the payload is empty.
    static func write(
        destination: ShareInboxDestination,
        text: String?,
        files: [(filename: String, mimeType: String, data: Data)],
        containerURL: URL? = defaultContainerURL(),
        now: Date = Date()
    ) -> String? {
        guard let containerURL else {
            return nil
        }
        let trimmed = trimmedText(text)
        let boundedFiles = Array(files.prefix(maxFiles)).filter { file in
            !file.data.isEmpty && file.data.count <= maxFileBytes
        }
        if trimmed == nil && boundedFiles.isEmpty {
            return nil
        }

        let id = UUID().uuidString
        let itemURL = containerURL.appendingPathComponent(id, isDirectory: true)
        let fileDir = itemURL.appendingPathComponent(filesDirectoryName, isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: fileDir,
                withIntermediateDirectories: true
            )
        } catch {
            return nil
        }

        var refs: [ShareInboxFile] = []
        for (index, file) in boundedFiles.enumerated() {
            let safeName = sanitizedFilename(file.filename)
            let relativePath = "\(filesDirectoryName)/\(index)-\(safeName)"
            let dest = itemURL.appendingPathComponent(relativePath)
            do {
                try file.data.write(to: dest, options: .atomic)
            } catch {
                try? FileManager.default.removeItem(at: itemURL)
                return nil
            }
            refs.append(
                ShareInboxFile(
                    filename: safeName,
                    mimeType: file.mimeType.isEmpty
                        ? "application/octet-stream"
                        : file.mimeType,
                    relativePath: relativePath
                )
            )
        }

        let item = ShareInboxItem(
            schemaVersion: ShareInboxItem.currentSchemaVersion,
            id: id,
            createdAt: now,
            destination: destination,
            text: trimmed,
            files: refs
        )
        guard let data = try? encoder.encode(item) else {
            try? FileManager.default.removeItem(at: itemURL)
            return nil
        }
        do {
            try data.write(
                to: itemURL.appendingPathComponent(manifestName),
                options: .atomic
            )
        } catch {
            try? FileManager.default.removeItem(at: itemURL)
            return nil
        }
        sweepExpired(in: containerURL, now: now, keeping: id)
        return id
    }

    /// Host-cache directory files are copied into before the inbox item is
    /// deleted. Injectable in tests via the `exportDirectory` argument on
    /// `consume`.
    static func exportDirectory(for id: String) -> URL? {
        guard isSafeItemId(id) else {
            return nil
        }
        return FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("ShareInboxExport", isDirectory: true)
            .appendingPathComponent(id, isDirectory: true)
    }

    /// Return and delete the item named `id`, or `nil` when it is missing,
    /// stale, or unreadable. Files are copied to `exportDirectory` (or the
    /// default host-cache folder) first so the web layer can still read them.
    static func consume(
        id: String,
        exportDirectory: URL? = nil,
        containerURL: URL? = defaultContainerURL(),
        now: Date = Date()
    ) -> ShareInboxConsumption? {
        guard let containerURL, isSafeItemId(id) else {
            return nil
        }
        return take(
            itemURL: containerURL.appendingPathComponent(id, isDirectory: true),
            exportDirectory: exportDirectory ?? Self.exportDirectory(for: id),
            now: now
        )
    }

    /// Return and delete the newest unexpired item, or `nil` when the inbox
    /// is empty. Used when the command URL never arrived (the extension
    /// could not open the host) and the user opened the app by hand.
    static func consumeLatest(
        exportDirectory: URL? = nil,
        containerURL: URL? = defaultContainerURL(),
        now: Date = Date()
    ) -> ShareInboxConsumption? {
        guard let containerURL else {
            return nil
        }
        sweepExpired(in: containerURL, now: now)
        let items = (try? FileManager.default.contentsOfDirectory(
            at: containerURL,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        let newest = items.max { lhs, rhs in
            let left = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey])
                .contentModificationDate) ?? .distantPast
            let right = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey])
                .contentModificationDate) ?? .distantPast
            return left < right
        }
        guard let newest else {
            return nil
        }
        let id = newest.lastPathComponent
        return take(
            itemURL: newest,
            exportDirectory: exportDirectory ?? Self.exportDirectory(for: id),
            now: now
        )
    }

    /// Absolute path of a file that still belongs to `item`.
    static func fileURL(
        for file: ShareInboxFile,
        itemId: String,
        containerURL: URL? = defaultContainerURL()
    ) -> URL? {
        guard let containerURL, isSafeItemId(itemId), isSafeRelativePath(file.relativePath) else {
            return nil
        }
        let root = containerURL.appendingPathComponent(itemId, isDirectory: true)
            .standardizedFileURL
        let url = root.appendingPathComponent(file.relativePath).standardizedFileURL
        guard url.path.hasPrefix(root.path + "/") else {
            return nil
        }
        return url
    }

    static func postReadyNotification() {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(readyNotificationName),
            nil,
            nil,
            true
        )
    }

    private static func take(
        itemURL: URL,
        exportDirectory: URL?,
        now: Date
    ) -> ShareInboxConsumption? {
        let manifestURL = itemURL.appendingPathComponent(manifestName)
        defer {
            try? FileManager.default.removeItem(at: itemURL)
        }
        guard let data = try? Data(contentsOf: manifestURL),
              let item = try? decoder.decode(ShareInboxItem.self, from: data),
              item.schemaVersion == ShareInboxItem.currentSchemaVersion,
              now.timeIntervalSince(item.createdAt) <= ttl
        else {
            return nil
        }
        let exported = exportFiles(item.files, from: itemURL, to: exportDirectory)
        return ShareInboxConsumption(
            id: item.id,
            destination: item.destination,
            text: item.text,
            files: exported
        )
    }

    private static func exportFiles(
        _ files: [ShareInboxFile],
        from itemURL: URL,
        to exportDirectory: URL?
    ) -> [ShareInboxExportedFile] {
        guard let exportDirectory else {
            return []
        }
        do {
            try FileManager.default.createDirectory(
                at: exportDirectory,
                withIntermediateDirectories: true
            )
        } catch {
            return []
        }
        let root = itemURL.standardizedFileURL
        var exported: [ShareInboxExportedFile] = []
        for (index, file) in files.enumerated() {
            guard isSafeRelativePath(file.relativePath) else {
                continue
            }
            let src = itemURL.appendingPathComponent(file.relativePath).standardizedFileURL
            guard src.path.hasPrefix(root.path + "/") else {
                continue
            }
            let destName = "\(index)-\(sanitizedFilename(file.filename))"
            let dest = exportDirectory.appendingPathComponent(destName)
            do {
                if FileManager.default.fileExists(atPath: dest.path) {
                    try FileManager.default.removeItem(at: dest)
                }
                try FileManager.default.copyItem(at: src, to: dest)
            } catch {
                continue
            }
            exported.append(
                ShareInboxExportedFile(
                    filename: sanitizedFilename(file.filename),
                    mimeType: file.mimeType,
                    path: dest.path
                )
            )
        }
        return exported
    }

    private static func sweepExpired(in containerURL: URL, now: Date, keeping keepId: String? = nil) {
        let items = (try? FileManager.default.contentsOfDirectory(
            at: containerURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []
        for url in items {
            if url.lastPathComponent == keepId {
                continue
            }
            let manifestURL = url.appendingPathComponent(manifestName)
            guard let data = try? Data(contentsOf: manifestURL),
                  let item = try? decoder.decode(ShareInboxItem.self, from: data),
                  now.timeIntervalSince(item.createdAt) <= ttl
            else {
                try? FileManager.default.removeItem(at: url)
                continue
            }
        }
    }

    static func trimmedText(_ text: String?) -> String? {
        guard let text else {
            return nil
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return nil
        }
        if trimmed.count > maxTextLength {
            return String(trimmed.prefix(maxTextLength))
        }
        return trimmed
    }

    static func sanitizedFilename(_ raw: String) -> String {
        let base = (raw as NSString).lastPathComponent
        let stripped = base
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: "\\", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let name = stripped.isEmpty ? "attachment" : stripped
        if name.count <= 200 {
            return name
        }
        let ext = (name as NSString).pathExtension
        let stem = (name as NSString).deletingPathExtension
        let clipped = String(stem.prefix(max(1, 200 - ext.count - 1)))
        return ext.isEmpty ? clipped : "\(clipped).\(ext)"
    }

    static func isSafeItemId(_ id: String) -> Bool {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-"))
        return !id.isEmpty && id.count <= 64 && id.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    private static func isSafeRelativePath(_ path: String) -> Bool {
        !path.isEmpty && !path.contains("..") && !path.hasPrefix("/")
    }
}
