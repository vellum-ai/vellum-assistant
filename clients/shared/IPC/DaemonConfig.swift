import Foundation

public struct DaemonConfig {
    #if os(macOS)
    public let socketPath: String

    public init(socketPath: String) {
        self.socketPath = socketPath
    }

    public static var `default`: DaemonConfig {
        let env = ProcessInfo.processInfo.environment
        let path = env["VELLUM_DAEMON_SOCKET"] ?? "\(NSHomeDirectory())/.vellum/vellum.sock"
        return DaemonConfig(socketPath: path)
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
        let port = UInt16(UserDefaults.standard.integer(forKey: "daemon_port"))
        let finalPort = port > 0 ? port : 8765
        return DaemonConfig(hostname: hostname, port: finalPort, useTLS: true)
    }
    #else
    #error("Unsupported platform")
    #endif
}
