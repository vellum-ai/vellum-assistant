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
        load(from: NSHomeDirectory() + "/.vellum/workspace/IDENTITY.md")
    }

    /// Load identity from a specific IDENTITY.md path.
    static func load(from path: String) -> IdentityInfo? {
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

    /// Parses an optional `## Identity Intro` section from SOUL.md.
    /// Returns a single short tagline or nil.
    static func loadIdentityIntro() -> String? {
        let path = NSHomeDirectory() + "/.vellum/workspace/SOUL.md"
        guard let content = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }

        var inSection = false

        for line in content.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("#") && trimmed.drop(while: { $0 == "#" }).first == " " {
                inSection = trimmed.lowercased().contains("identity intro")
                continue
            }
            if inSection {
                // The intro is the first non-empty line in the section
                if !trimmed.isEmpty {
                    return trimmed
                }
            }
        }
        return nil
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
        guard let info = IdentityInfo.load(from: identityPath) else { return nil }
        guard let resolved = AssistantDisplayName.firstUserFacing(from: [info.name]),
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
