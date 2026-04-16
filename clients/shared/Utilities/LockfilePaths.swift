import Foundation

public enum LockfilePaths {
    public static var primary: URL {
        VellumPaths.current.lockfileCandidates[0]
    }

    public static var primaryPath: String { primary.path }

    /// Read and parse the lockfile, iterating `VellumPaths.current.lockfileCandidates`
    /// in priority order. Returns nil if no candidate exists or all are malformed.
    public static func read() -> [String: Any]? {
        for url in VellumPaths.current.lockfileCandidates {
            guard let data = try? Data(contentsOf: url),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                continue
            }
            return json
        }
        return nil
    }

    /// Resolve the local gateway port: env var > lockfile > default 7830.
    ///
    /// When `connectedAssistantId` is provided the port is read from that
    /// specific lockfile entry instead of the most-recently-hatched one.
    /// This prevents multi-instance scenarios from targeting the wrong gateway.
    public static func resolveGatewayPort(connectedAssistantId: String? = nil) -> Int {
        if let envPort = ProcessInfo.processInfo.environment["GATEWAY_PORT"]
            ?? getenv("GATEWAY_PORT").flatMap({ String(cString: $0) }),
           let port = Int(envPort) {
            return port
        }
        if let json = read(),
           let assistants = json["assistants"] as? [[String: Any]] {
            let entry: [String: Any]?
            if let id = connectedAssistantId {
                entry = assistants.first(where: { ($0["assistantId"] as? String) == id })
            } else {
                entry = assistants.max(by: {
                    ($0["hatchedAt"] as? String ?? "") < ($1["hatchedAt"] as? String ?? "")
                })
            }
            if let entry,
               let resources = entry["resources"] as? [String: Any],
               let port = resources["gatewayPort"] as? Int {
                return port
            }
        }
        return 7830
    }

    /// Resolve the full gateway URL for the given (or latest) assistant.
    ///
    /// Resolution order:
    /// 1. `runtimeUrl` from the lockfile entry for `connectedAssistantId`
    ///    (falls back to the most-recently-hatched entry)
    /// 2. `http://127.0.0.1:{resolveGatewayPort()}`
    public static func resolveGatewayUrl(connectedAssistantId: String? = nil) -> String {
        if let json = read(),
           let assistants = json["assistants"] as? [[String: Any]] {
            let assistant: [String: Any]?
            if let id = connectedAssistantId {
                assistant = assistants.first(where: { ($0["assistantId"] as? String) == id })
            } else {
                assistant = assistants.max(by: {
                    ($0["hatchedAt"] as? String ?? "") < ($1["hatchedAt"] as? String ?? "")
                })
            }
            let cloud = (assistant?["cloud"] as? String ?? "local").lowercased()
            if cloud != "local",
               let runtimeUrl = assistant?["runtimeUrl"] as? String,
               !runtimeUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return runtimeUrl.trimmingCharacters(in: .whitespacesAndNewlines)
                    .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
            }
        }

        return "http://127.0.0.1:\(resolveGatewayPort(connectedAssistantId: connectedAssistantId))"
    }

}
