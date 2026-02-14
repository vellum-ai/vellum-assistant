import Foundation

public struct DaemonConfig {
    #if os(macOS)
    public let socketPath: String

    public init(socketPath: String) {
        self.socketPath = socketPath
    }

    public static var `default`: DaemonConfig {
        // Delegate to resolveSocketPath() to avoid duplication
        return DaemonConfig(socketPath: resolveSocketPath())
    }
    #elseif os(iOS)
    public let hostname: String
    public let port: UInt16

    public init(hostname: String, port: UInt16) {
        self.hostname = hostname
        self.port = port
    }

    public static var `default`: DaemonConfig {
        // Treat empty string as nil to ensure fallback to "localhost"
        let hostname = UserDefaults.standard.string(forKey: "daemon_hostname").flatMap { $0.isEmpty ? nil : $0 } ?? "localhost"
        let rawPort = UserDefaults.standard.integer(forKey: "daemon_port")
        // Validate port is in valid UInt16 range (1-65535) before converting to avoid crash
        let finalPort: UInt16 = (rawPort > 0 && rawPort <= 65535) ? UInt16(rawPort) : 8765
        return DaemonConfig(hostname: hostname, port: finalPort)
    }
    #else
    #error("Unsupported platform")
    #endif
}
