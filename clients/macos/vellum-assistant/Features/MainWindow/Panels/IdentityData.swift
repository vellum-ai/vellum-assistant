import SwiftUI
import VellumAssistantShared

// MARK: - Home Location

enum AssistantHome: Equatable {
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
                continue
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

struct IdentityInfo: Codable, Equatable {
    let name: String
    let role: String
    let personality: String
    let emoji: String
    /// Parsed home location. Not persisted across launches because
    /// `AssistantHome` is an enum with associated values and the field is
    /// only consumed from a fresh fetch. After a `IdentityInfoStore` reload
    /// this will be `nil` until the next live `loadAsync()`.
    let home: AssistantHome?

    init(name: String, role: String, personality: String, emoji: String, home: AssistantHome?) {
        self.name = name
        self.role = role
        self.personality = personality
        self.emoji = emoji
        self.home = home
    }

    // MARK: - Codable (skips `home`)

    private enum CodingKeys: String, CodingKey {
        case name, role, personality, emoji
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.name = try container.decode(String.self, forKey: .name)
        self.role = try container.decode(String.self, forKey: .role)
        self.personality = try container.decode(String.self, forKey: .personality)
        self.emoji = try container.decode(String.self, forKey: .emoji)
        self.home = nil
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(role, forKey: .role)
        try container.encode(personality, forKey: .personality)
        try container.encode(emoji, forKey: .emoji)
    }

    // MARK: - Per-assistant cache

    /// Map of `assistantId → identity`, persisted across launches via
    /// `IdentityInfoStore`. Populated incrementally as the user visits each
    /// assistant: every successful identity fetch writes the result under
    /// the currently active assistant id and is then available for any UI
    /// surface that needs to render that assistant by id (e.g. the menu-bar
    /// switcher rendering names for non-active rows).
    ///
    /// All reads and writes are confined to `@MainActor` to eliminate
    /// data races between async writers and synchronous readers.
    @MainActor private static var cachedByAssistantId: [String: IdentityInfo] = IdentityInfoStore.load()

    /// The cached identity for the currently active assistant, if any.
    /// Equivalent to the legacy `IdentityInfo.current` singleton — kept
    /// under that name so existing call sites (menu bar, command palette,
    /// session overlay) read unchanged.
    @MainActor static var current: IdentityInfo? {
        guard let activeId = LockfileAssistant.loadActiveAssistantId() else { return nil }
        return cachedByAssistantId[activeId]
    }

    /// Look up the cached identity for an arbitrary assistant id. Used by
    /// the menu-bar switcher to render names for non-active rows.
    @MainActor static func cached(for assistantId: String) -> IdentityInfo? {
        cachedByAssistantId[assistantId]
    }

    /// Populate (or refresh) the cache for the currently active assistant
    /// via the gateway API. Call this at app launch, on workspace switch,
    /// and whenever IDENTITY.md is known to have changed.
    @MainActor @discardableResult
    static func refreshCache() async -> IdentityInfo? {
        let info = await loadAsync()
        store(info)
        return info
    }

    /// Seeds the cache for the currently active assistant via the gateway API.
    @MainActor static func warmCache() async {
        let info = await loadAsync()
        store(info)
    }

    /// Writes `info` into the per-assistant cache under the currently active
    /// id and persists the map to disk. No-op when there's no active id or
    /// the fetch returned nil — we never want to evict a known-good entry
    /// just because a single fetch failed.
    @MainActor private static func store(_ info: IdentityInfo?) {
        guard let info, let activeId = LockfileAssistant.loadActiveAssistantId() else { return }
        if cachedByAssistantId[activeId] == info { return }
        cachedByAssistantId[activeId] = info
        IdentityInfoStore.save(cachedByAssistantId)
    }

    /// Seeds the cache with a placeholder identity for a newly created
    /// assistant so the menu-bar switcher can display the name immediately
    /// without waiting for a full gateway fetch. The seeded entry will be
    /// overwritten by real data when the user connects to the assistant
    /// and `refreshCache()` runs.
    @MainActor static func seedCache(name: String, forAssistantId assistantId: String) {
        let placeholder = IdentityInfo(
            name: name,
            role: "",
            personality: "",
            emoji: "",
            home: nil
        )
        guard cachedByAssistantId[assistantId] == nil else { return }
        cachedByAssistantId[assistantId] = placeholder
        IdentityInfoStore.save(cachedByAssistantId)
    }

    /// Load identity from the gateway API (assistant-side IDENTITY.md parsing).
    /// Respects structured cancellation from SwiftUI `.task` modifiers.
    static func loadAsync() async -> IdentityInfo? {
        guard let remote = await IdentityClient().fetchRemoteIdentity() else { return nil }
        guard !remote.name.isEmpty else { return nil }
        let home = remote.home.flatMap { $0.isEmpty ? nil : AssistantHome.parse($0) }
        return IdentityInfo(name: remote.name, role: remote.role, personality: remote.personality, emoji: remote.emoji, home: home)
    }

    /// Load identity and metadata from a single gateway fetch.
    /// Use this when both are needed to avoid duplicate HTTP requests.
    static func loadWithMetadata() async -> (identity: IdentityInfo?, metadata: AssistantMetadata) {
        guard let remote = await IdentityClient().fetchRemoteIdentity() else {
            return (nil, AssistantMetadata(version: "v1.0", createdAt: nil))
        }
        let identity: IdentityInfo? = {
            guard !remote.name.isEmpty else { return nil }
            let home = remote.home.flatMap { $0.isEmpty ? nil : AssistantHome.parse($0) }
            return IdentityInfo(name: remote.name, role: remote.role, personality: remote.personality, emoji: remote.emoji, home: home)
        }()
        return (identity, AssistantMetadata.from(remote: remote))
    }

    /// Async loading via the gateway identity/intro endpoint.
    static func loadIdentityIntroAsync() async -> String? {
        await IdentityClient().fetchIdentityIntro()
    }

    /// Async loading via the gateway workspace API (fetches SOUL.md content).
    static func loadGreetingsAsync() async -> [String] {
        guard let content = await WorkspaceClient().fetchWorkspaceFile(path: "SOUL.md", showHidden: false)?.content else {
            return []
        }
        return parseGreetings(from: content)
    }

    /// Extract greeting lines from the `## Greetings` section of SOUL.md content.
    private static func parseGreetings(from content: String) -> [String] {
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

    /// Build metadata from an already-fetched remote identity response.
    static func from(remote: RemoteIdentityInfo) -> AssistantMetadata {
        let createdAt: Date? = remote.createdAt.flatMap { dateStr in
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let fallback = ISO8601DateFormatter()
            fallback.formatOptions = [.withInternetDateTime]
            return formatter.date(from: dateStr) ?? fallback.date(from: dateStr)
        }
        return AssistantMetadata(version: remote.version ?? "v1.0", createdAt: createdAt)
    }
}

// MARK: - Lockfile Assistant Extensions (macOS-specific UI helpers)

extension LockfileAssistant {
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

    /// Reads the human-readable name from this assistant's IDENTITY.md.
    /// Returns `nil` if the file doesn't exist, the name hasn't been set yet,
    /// or the name is the generic "Assistant" placeholder.
    func loadDisplayName() -> String? {
        guard let base = instanceDir else { return nil }
        let identityPath = base + "/.vellum/workspace/IDENTITY.md"
        guard let content = try? String(contentsOfFile: identityPath, encoding: .utf8) else { return nil }
        var name = ""
        for line in content.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.lowercased().hasPrefix("- **name:**") {
                name = trimmed.components(separatedBy: ":**").last?.trimmingCharacters(in: .whitespaces) ?? ""
                break
            }
        }
        guard let resolved = AssistantDisplayName.firstUserFacing(from: [name]),
              resolved != AssistantDisplayName.placeholder else { return nil }
        return resolved
    }
}

// MARK: - Workspace File Node (checks file existence)

struct WorkspaceFileNode: Identifiable {
    let id = UUID()
    let label: String
    let path: String
    let exists: Bool

    /// Check file existence via the gateway workspace tree API.
    static func scanAsync() async -> [WorkspaceFileNode] {
        guard let tree = await WorkspaceClient().fetchWorkspaceTree(path: "", showHidden: false) else {
            return [
                WorkspaceFileNode(label: "IDENTITY.md", path: "IDENTITY.md", exists: false),
                WorkspaceFileNode(label: "SOUL.md", path: "SOUL.md", exists: false),
                WorkspaceFileNode(label: "USER.md", path: "USER.md", exists: false),
                WorkspaceFileNode(label: "skills/", path: "skills", exists: false),
            ]
        }
        let names = Set(tree.entries.map { $0.name })
        return [
            WorkspaceFileNode(label: "IDENTITY.md", path: "IDENTITY.md", exists: names.contains("IDENTITY.md")),
            WorkspaceFileNode(label: "SOUL.md", path: "SOUL.md", exists: names.contains("SOUL.md")),
            WorkspaceFileNode(label: "USER.md", path: "USER.md", exists: names.contains("USER.md")),
            WorkspaceFileNode(label: "skills/", path: "skills", exists: names.contains("skills")),
        ]
    }
}
