import Foundation
import os

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "PortDiagnostics"
)

/// Captures a snapshot of which processes are listening on assistant-relevant
/// TCP ports. Written as a standalone JSON file inside the log export archive.
enum PortDiagnostics {

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
        } catch {
            return nil
        }

        // Read pipe data before waitUntilExit to avoid deadlock when
        // the pipe buffer fills up and the subprocess blocks on write.
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
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

    /// Discovers all listening TCP ports owned by processes whose command
    /// name contains "vellum" (case-insensitive).
    private static func collectPorts() -> [(label: String, port: Int)] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        process.arguments = ["-i", "TCP", "-sTCP:LISTEN", "-n", "-P"]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            return []
        }

        // Read pipe data before waitUntilExit to avoid deadlock when
        // the pipe buffer fills up and the subprocess blocks on write.
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard let output = String(data: data, encoding: .utf8) else { return [] }

        // lsof output columns: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
        // NAME for TCP looks like "*:7821 (LISTEN)" or "127.0.0.1:7830 (LISTEN)"
        var results: [(label: String, port: Int)] = []
        var seen = Set<Int>()

        let lines = output.components(separatedBy: "\n").dropFirst() // skip header
        for line in lines {
            let parts = line.split(separator: " ", omittingEmptySubsequences: true)
            guard parts.count >= 9 else { continue }

            let command = String(parts[0])
            guard command.localizedCaseInsensitiveContains("vellum") else { continue }

            // The NAME column is second-to-last (before the state in parens).
            // Format: "*:PORT" or "host:PORT"
            let name = String(parts[8])
            guard let colonIndex = name.lastIndex(of: ":") else { continue }
            let portString = name[name.index(after: colonIndex)...]
            guard let port = Int(portString), !seen.contains(port) else { continue }

            seen.insert(port)
            results.append(("\(command) (pid \(parts[1]))", port))
        }

        return results
    }
}
