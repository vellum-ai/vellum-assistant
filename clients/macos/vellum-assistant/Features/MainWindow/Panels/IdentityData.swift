import SwiftUI
import VellumAssistantShared

// MARK: - Home Location

enum AssistantHome {
    case local(workspacePath: String)
    case gcp(project: String, zone: String, instance: String)
    case aws(project: String, region: String, instance: String)
    case custom(ip: String, port: String)
    case vellum(runtimeUrl: String)

    var displayLabel: String {
        switch self {
        case .local: return "Local"
        case .gcp: return "GCP"
        case .aws: return "AWS"
        case .custom: return "Custom"
        case .vellum: return "Vellum"
        }
    }

    var displayDetails: [(label: String, value: String)] {
        switch self {
        case .local(let workspacePath):
            return [("Path", workspacePath)]
        case .gcp(let project, let zone, let instance):
            return [("Project", project), ("Zone", zone), ("Instance", instance)]
        case .aws(let project, let region, let instance):
            return [("Project", project), ("Region", region), ("Instance", instance)]
        case .custom(let ip, let port):
            return [("IP", ip), ("Port", port)]
        case .vellum(let runtimeUrl):
            return [("URL", runtimeUrl)]
        }
    }

    static func parse(_ raw: String) -> AssistantHome? {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        let lower = trimmed.lowercased()

        if lower.hasPrefix("local") {
            let detail = extractParenContent(trimmed)
            let path = detail ?? NSHomeDirectory() + "/.vellum/workspace"
            return .local(workspacePath: path)
        }

        if lower.hasPrefix("gcp") {
            guard let detail = extractParenContent(trimmed) else { return .gcp(project: "", zone: "", instance: "") }
            let parts = detail.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            return .gcp(
                project: keyValue(parts, key: "project"),
                zone: keyValue(parts, key: "zone"),
                instance: keyValue(parts, key: "instance")
            )
        }

        if lower.hasPrefix("aws") {
            guard let detail = extractParenContent(trimmed) else { return .aws(project: "", region: "", instance: "") }
            let parts = detail.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            return .aws(
                project: keyValue(parts, key: "project"),
                region: keyValue(parts, key: "region"),
                instance: keyValue(parts, key: "instance")
            )
        }

        if lower.hasPrefix("custom") {
            guard let detail = extractParenContent(trimmed) else { return .custom(ip: "", port: "") }
            let parts = detail.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            return .custom(
                ip: keyValue(parts, key: "ip"),
                port: keyValue(parts, key: "port")
            )
        }

        return nil
    }

    private static func extractParenContent(_ str: String) -> String? {
        guard let open = str.firstIndex(of: "("),
              let close = str.lastIndex(of: ")") else { return nil }
        return String(str[str.index(after: open)..<close])
    }

    private static func keyValue(_ parts: [String], key: String) -> String {
        for part in parts {
            let kv = part.components(separatedBy: ":")
            if kv.count == 2, kv[0].trimmingCharacters(in: .whitespaces).lowercased() == key.lowercased() {
                return kv[1].trimmingCharacters(in: .whitespaces)
            }
        }
        return parts.first(where: { !$0.contains(":") })?.trimmingCharacters(in: .whitespaces) ?? ""
    }
}

enum AssistantDisplayName {
    static let placeholder = "Assistant"
    private static let hiddenBootstrapPrefix = "_("

    /// Freshly hatched assistants can briefly persist an internal bootstrap
    /// instruction as the name. Mask that sentinel in all user-facing UI.
    static func firstUserFacing(from candidates: [String?]) -> String? {
        for candidate in candidates {
            guard let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !trimmed.isEmpty else { continue }
            if trimmed.hasPrefix(hiddenBootstrapPrefix) {
                return placeholder
            }
            return trimmed
        }

        return nil
    }

    static func resolve(_ candidates: String?..., fallback: String = placeholder) -> String {
        firstUserFacing(from: candidates) ?? fallback
    }
}

// MARK: - Identity Info (parsed from IDENTITY.md)

struct IdentityInfo {
    let name: String
    let role: String
    let personality: String
    let emoji: String
    let home: AssistantHome?

    static func load() -> IdentityInfo? {
        let path = NSHomeDirectory() + "/.vellum/workspace/IDENTITY.md"
        guard let content = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }

        var name = ""
        var role = ""
        var personality = ""
        var emoji = ""
        var homeRaw = ""

        for line in content.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.lowercased().hasPrefix("- **name:**") {
                name = trimmed.components(separatedBy: ":**").last?.trimmingCharacters(in: .whitespaces) ?? ""
            } else if trimmed.lowercased().hasPrefix("- **role:**") {
                role = trimmed.components(separatedBy: ":**").last?.trimmingCharacters(in: .whitespaces) ?? ""
            } else if trimmed.lowercased().hasPrefix("- **personality:**") || trimmed.lowercased().hasPrefix("- **vibe:**") {
                personality = trimmed.components(separatedBy: ":**").last?.trimmingCharacters(in: .whitespaces) ?? ""
            } else if trimmed.lowercased().hasPrefix("- **emoji:**") {
                emoji = trimmed.components(separatedBy: ":**").last?.trimmingCharacters(in: .whitespaces) ?? ""
            } else if trimmed.lowercased().hasPrefix("- **home:**") {
                homeRaw = trimmed.components(separatedBy: ":**").last?.trimmingCharacters(in: .whitespaces) ?? ""
            }
        }

        guard !name.isEmpty else { return nil }
        let home = homeRaw.isEmpty ? nil : AssistantHome.parse(homeRaw)
        return IdentityInfo(name: name, role: role, personality: personality, emoji: emoji, home: home)
    }

    /// Parses an optional `## Greetings` section from SOUL.md.
    /// The assistant is expected to maintain this section as part of its personality.
    static func loadGreetings() -> [String] {
        let path = NSHomeDirectory() + "/.vellum/workspace/SOUL.md"
        guard let content = try? String(contentsOfFile: path, encoding: .utf8) else { return [] }

        var greetings: [String] = []
        var inGreetingsSection = false

        for line in content.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("#") && trimmed.drop(while: { $0 == "#" }).first == " " {
                inGreetingsSection = trimmed.lowercased().contains("greetings")
                continue
            }
            if inGreetingsSection {
                if trimmed.hasPrefix("- ") {
                    var greeting = String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces)
                    // Strip surrounding quotes if present
                    if greeting.count >= 2,
                       (greeting.hasPrefix("\"") && greeting.hasSuffix("\""))
                        || (greeting.hasPrefix("\u{201C}") && greeting.hasSuffix("\u{201D}")) {
                        greeting = String(greeting.dropFirst().dropLast())
                    }
                    if !greeting.isEmpty { greetings.append(greeting) }
                }
            }
        }
        return greetings
    }

    /// Deterministic 8-character hex agent ID derived from the identity name.
    var agentID: String {
        var hash: UInt64 = 0xcbf29ce484222325 // FNV-1a offset basis
        for byte in name.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3 // FNV prime
        }
        return String(format: "%08X", UInt32(truncatingIfNeeded: hash))
    }
}

// MARK: - Assistant Metadata

struct AssistantMetadata {
    let version: String
    let createdAt: Date?
    let originSystem: String

    static func load() -> AssistantMetadata {
        let identityPath = NSHomeDirectory() + "/.vellum/workspace/IDENTITY.md"
        let fm = FileManager.default

        // Version from IDENTITY.md modified date count (simple lineage)
        let version = "v1.0"

        // Created at = IDENTITY.md creation date
        let createdAt: Date?
        if let attrs = try? fm.attributesOfItem(atPath: identityPath),
           let date = attrs[.creationDate] as? Date {
            createdAt = date
        } else {
            createdAt = nil
        }

        // Origin system
        let originSystem = Host.current().localizedName ?? "local"

        return AssistantMetadata(version: version, createdAt: createdAt, originSystem: originSystem)
    }
}

// MARK: - Lockfile Assistant (parsed from ~/.vellum.lock.json)

struct LockfileAssistant {
    let assistantId: String
    let runtimeUrl: String?
    let bearerToken: String?
    let cloud: String
    let project: String?
    let region: String?
    let zone: String?
    let instanceId: String?
    let hatchedAt: String?
    let baseDataDir: String?
    let daemonPort: Int?
    let gatewayPort: Int?
    let instanceDir: String?

    /// Whether this assistant is running remotely (not on the local machine).
    var isRemote: Bool {
        cloud.lowercased() != "local"
    }

    /// Whether this is a platform-managed assistant.
    var isManaged: Bool {
        cloud.lowercased() == "vellum"
    }

    var home: AssistantHome {
        switch cloud.lowercased() {
        case "gcp":
            return .gcp(
                project: project ?? "",
                zone: zone ?? "",
                instance: instanceId ?? ""
            )
        case "aws":
            return .aws(
                project: project ?? "",
                region: region ?? "",
                instance: instanceId ?? ""
            )
        case "custom":
            if let runtimeUrl,
               let url = URL(string: runtimeUrl),
               let host = url.host {
                let port = url.port.map(String.init) ?? ""
                return .custom(ip: host, port: port)
            }
            return .custom(ip: "", port: "")
        case "vellum":
            return .vellum(runtimeUrl: runtimeUrl ?? "")
        default:
            let base = instanceDir ?? NSHomeDirectory()
            return .local(workspacePath: base + "/.vellum/workspace")
        }
    }

    /// Resolve the assistant's local runtime HTTP port from the lockfile when
    /// available, otherwise fall back to the current process environment.
    func resolvedDaemonPort(environment: [String: String]? = nil) -> Int {
        if let daemonPort {
            return daemonPort
        }

        let rawPort: String?
        if let environment {
            rawPort = environment["RUNTIME_HTTP_PORT"]
        } else {
            let env = ProcessInfo.processInfo.environment
            rawPort = env["RUNTIME_HTTP_PORT"]
                ?? getenv("RUNTIME_HTTP_PORT").map { String(cString: $0) }
        }
        return rawPort.flatMap(Int.init) ?? 7821
    }

    var localRuntimeBaseURL: String {
        "http://localhost:\(resolvedDaemonPort())"
    }

    static func loadLatest() -> LockfileAssistant? {
        loadAll().first
    }

    /// Returns all assistant entries from the lockfile, sorted newest first.
    static func loadAll() -> [LockfileAssistant] {
        guard let json = LockfilePaths.read(),
              let assistants = json["assistants"] as? [[String: Any]] else {
            return []
        }

        let fractionalFormatter = ISO8601DateFormatter()
        fractionalFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plainFormatter = ISO8601DateFormatter()
        plainFormatter.formatOptions = [.withInternetDateTime]

        func parseISO8601(_ s: String) -> Date? {
            fractionalFormatter.date(from: s) ?? plainFormatter.date(from: s)
        }

        let sorted = assistants.sorted { a, b in
            let dateA = (a["hatchedAt"] as? String).flatMap(parseISO8601) ?? .distantPast
            let dateB = (b["hatchedAt"] as? String).flatMap(parseISO8601) ?? .distantPast
            return dateA > dateB
        }

        return sorted.compactMap { entry -> LockfileAssistant? in
            guard let assistantId = entry["assistantId"] as? String else { return nil }
            let resources = entry["resources"] as? [String: Any]
            return LockfileAssistant(
                assistantId: assistantId,
                runtimeUrl: entry["runtimeUrl"] as? String,
                bearerToken: entry["bearerToken"] as? String,
                cloud: entry["cloud"] as? String ?? "local",
                project: entry["project"] as? String,
                region: entry["region"] as? String,
                zone: entry["zone"] as? String,
                instanceId: entry["instanceId"] as? String,
                hatchedAt: entry["hatchedAt"] as? String,
                baseDataDir: entry["baseDataDir"] as? String,
                daemonPort: resources?["daemonPort"] as? Int,
                gatewayPort: resources?["gatewayPort"] as? Int,
                instanceDir: resources?["instanceDir"] as? String
            )
        }
    }

    /// Find an assistant by its ID in the lockfile.
    static func loadByName(_ name: String) -> LockfileAssistant? {
        loadAll().first { $0.assistantId == name }
    }

    /// Writes this assistant's config to `~/.vellum/workspace/config.json`
    /// via `WorkspaceConfigIO.merge()`.
    func writeToWorkspaceConfig() {
        var homeConfig: [String: Any] = ["cloud": cloud]
        if let runtimeUrl { homeConfig["runtimeUrl"] = runtimeUrl }
        if let project { homeConfig["project"] = project }
        if let region { homeConfig["region"] = region }
        if let zone { homeConfig["zone"] = zone }
        if let instanceId { homeConfig["instanceId"] = instanceId }

        let existing = WorkspaceConfigIO.read()
        var assistantConfig = existing["assistant"] as? [String: Any] ?? [:]
        assistantConfig["id"] = assistantId
        assistantConfig["home"] = homeConfig
        try? WorkspaceConfigIO.merge(["assistant": assistantConfig])
    }

    /// Inserts or updates a managed (cloud = "vellum") entry in the lockfile.
    ///
    /// If an entry with the same `assistantId` already exists, it is updated
    /// in place. Otherwise a new entry is appended. All other entries are
    /// preserved unchanged.
    ///
    /// - Parameters:
    ///   - assistantId: The platform-assigned assistant UUID string.
    ///   - runtimeUrl: The platform base URL used for managed transport.
    ///   - hatchedAt: ISO-8601 timestamp of when the assistant was created.
    ///   - lockfilePath: Override for tests; defaults to `LockfilePaths.primaryPath`.
    @discardableResult
    static func upsertManagedEntry(
        assistantId: String,
        runtimeUrl: String,
        hatchedAt: String,
        lockfilePath: String? = nil
    ) -> Bool {
        let path = lockfilePath ?? LockfilePaths.primaryPath
        let fileURL = URL(fileURLWithPath: path)

        // Read existing lockfile: try primary first, then fall back to
        // LockfilePaths.read() which includes legacy path migration.
        var lockfile: [String: Any]
        if let data = try? Data(contentsOf: fileURL),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            lockfile = json
        } else if lockfilePath == nil, let legacy = LockfilePaths.read() {
            // Primary doesn't exist but legacy does — migrate entries forward.
            lockfile = legacy
        } else {
            lockfile = [:]
        }

        var assistants = lockfile["assistants"] as? [[String: Any]] ?? []

        let newEntry: [String: Any] = [
            "assistantId": assistantId,
            "runtimeUrl": runtimeUrl,
            "cloud": "vellum",
            "hatchedAt": hatchedAt,
        ]

        // Find existing entry with the same assistantId and update, or append.
        if let existingIndex = assistants.firstIndex(where: { ($0["assistantId"] as? String) == assistantId }) {
            assistants[existingIndex] = newEntry
        } else {
            assistants.append(newEntry)
        }

        lockfile["assistants"] = assistants

        // Write atomically.
        do {
            let data = try JSONSerialization.data(
                withJSONObject: lockfile,
                options: [.prettyPrinted, .sortedKeys]
            )
            let directory = fileURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
            try data.write(to: fileURL, options: .atomic)
            return true
        } catch {
            return false
        }
    }
}

// MARK: - Workspace File Node (checks file existence)

struct WorkspaceFileNode: Identifiable {
    let id = UUID()
    let label: String
    let path: String
    let exists: Bool

    static func scan() -> [WorkspaceFileNode] {
        let base = NSHomeDirectory() + "/.vellum/workspace"
        let fm = FileManager.default
        return [
            WorkspaceFileNode(label: "IDENTITY.md", path: base + "/IDENTITY.md", exists: fm.fileExists(atPath: base + "/IDENTITY.md")),
            WorkspaceFileNode(label: "SOUL.md", path: base + "/SOUL.md", exists: fm.fileExists(atPath: base + "/SOUL.md")),
            WorkspaceFileNode(label: "USER.md", path: base + "/USER.md", exists: fm.fileExists(atPath: base + "/USER.md")),
            WorkspaceFileNode(label: "skills/", path: base + "/skills", exists: fm.fileExists(atPath: base + "/skills")),
        ]
    }
}
