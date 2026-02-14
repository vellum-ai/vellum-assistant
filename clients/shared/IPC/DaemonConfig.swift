import Foundation

public struct DaemonConfig {
    #if os(macOS)
    public let socketPath: String

    public init(socketPath: String) {
        self.socketPath = socketPath
    }

    public static var `default`: DaemonConfig {
        // Socket path normalization logic (matches DaemonClient.resolveSocketPath):
        // - Trim whitespace/newlines from env var
        // - Fall back to default if empty or whitespace-only
        // - Expand ~/ prefix
        let env = ProcessInfo.processInfo.environment
        if let envPath = env["VELLUM_DAEMON_SOCKET"], !envPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let trimmed = envPath.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.hasPrefix("~/") {
                return DaemonConfig(socketPath: NSHomeDirectory() + "/" + String(trimmed.dropFirst(2)))
            }
            return DaemonConfig(socketPath: trimmed)
        }
        return DaemonConfig(socketPath: NSHomeDirectory() + "/.vellum/vellum.sock")
    }
    #elseif os(iOS)
    public let hostname: String
    public let port: UInt16
    public let useTLS: Bool

    public init(hostname: String, port: UInt16, useTLS: Bool = true) {
        self.hostname = hostname
        self.port = port
        self.useTLS = useTLS
    }

    public static var `default`: DaemonConfig {
        let hostname = UserDefaults.standard.string(forKey: "daemon_hostname") ?? "localhost"
        let rawPort = UserDefaults.standard.integer(forKey: "daemon_port")
        // Validate port is in valid UInt16 range (1-65535) before converting to avoid crash
        let finalPort: UInt16 = (rawPort > 0 && rawPort <= 65535) ? UInt16(rawPort) : 8765
        return DaemonConfig(hostname: hostname, port: finalPort, useTLS: true)
    }
    #else
    #error("Unsupported platform")
    #endif
}
