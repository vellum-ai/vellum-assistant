import Foundation
import os

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "PortDiagnostics"
)

/// Captures a snapshot of which processes are listening on assistant-relevant
/// TCP ports. Written as a standalone JSON file inside the log export archive.
enum PortDiagnostics {

    /// Default ports used by the assistant stack.
    private static let defaultDaemonPort = 7821
    private static let defaultGatewayPort = 7830
    private static let defaultQdrantPort = 6333

    /// Writes a `port-diagnostics.json` file to `directory` containing
    /// listener info for every port the assistant stack may use.
    nonisolated static func write(to url: URL) {
        let portsToCheck = collectPorts()

        var entries: [[String: Any]] = []
        for (label, port) in portsToCheck {
            var entry: [String: Any] = ["label": label, "port": port]
            if let info = listenerInfo(port: port) {
                entry["pid"] = info.pid
                entry["command"] = info.command
                entry["user"] = info.user
            } else {
                entry["status"] = "available"
            }
            entries.append(entry)
        }

        let payload: [String: Any] = [
            "capturedAt": ISO8601DateFormatter().string(from: Date()),
            "ports": entries,
        ]

        guard let data = try? JSONSerialization.data(
            withJSONObject: payload,
            options: [.prettyPrinted, .sortedKeys]
        ) else { return }

        do {
            try data.write(to: url)
        } catch {
            log.error("Failed to write port diagnostics: \(error.localizedDescription)")
        }
    }

    // MARK: - Private

    private struct ListenerInfo {
        let pid: Int
        let command: String
        let user: String
    }

    /// Runs `lsof` to find the process listening on a TCP port.
    private static func listenerInfo(port: Int) -> ListenerInfo? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        process.arguments = ["-iTCP:\(port)", "-sTCP:LISTEN", "-n", "-P"]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return nil
        }

        let data = pipe.fileHandleForReading.availableData
        guard let output = String(data: data, encoding: .utf8) else { return nil }

        // lsof output: header line then result lines.
        // Columns: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
        let lines = output.components(separatedBy: "\n")
        guard lines.count >= 2 else { return nil }

        let parts = lines[1].split(separator: " ", omittingEmptySubsequences: true)
        guard parts.count >= 3 else { return nil }

        let command = String(parts[0])
        let pid = Int(parts[1])
        let user = String(parts[2])

        guard let pid else { return nil }
        return ListenerInfo(pid: pid, command: command, user: user)
    }

    /// Collects all ports worth checking: the three default ports plus any
    /// lockfile-specific ports that differ from the defaults.
    private static func collectPorts() -> [(label: String, port: Int)] {
        var ports: [(label: String, port: Int)] = [
            ("daemon (default)", defaultDaemonPort),
            ("gateway (default)", defaultGatewayPort),
            ("qdrant (default)", defaultQdrantPort),
        ]

        let seen: Set<Int> = [defaultDaemonPort, defaultGatewayPort, defaultQdrantPort]

        let assistants = LockfileAssistant.loadAll()
        for assistant in assistants {
            if let dp = assistant.daemonPort, !seen.contains(dp) {
                ports.append(("daemon (\(assistant.assistantId))", dp))
            }
            if let gp = assistant.gatewayPort, !seen.contains(gp) {
                ports.append(("gateway (\(assistant.assistantId))", gp))
            }
        }

        return ports
    }
}
