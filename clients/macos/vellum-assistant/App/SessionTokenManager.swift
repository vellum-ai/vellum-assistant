import Foundation
import Security

extension Notification.Name {
    static let sessionTokenDidChange = Notification.Name("SessionTokenManager.didChange")
}

enum SessionTokenManager {
    private static let service = "vellum-assistant"
    private static let account = "session-token"

    static func getToken() -> String? {
        cliGetKey(service: service, account: account)
    }

    static func setToken(_ token: String) {
        cliSetKey(service: service, account: account, value: token)
        NotificationCenter.default.post(name: .sessionTokenDidChange, object: nil)
    }

    static func deleteToken() {
        cliDeleteKey(service: service, account: account)
        NotificationCenter.default.post(name: .sessionTokenDidChange, object: nil)
    }

    private static func cliGetKey(service: String, account: String) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["find-generic-password", "-s", service, "-a", account, "-w"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .newlines)
        } catch {
            return nil
        }
    }

    private static func cliSetKey(service: String, account: String, value: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["add-generic-password", "-s", service, "-a", account, "-w", value, "-U"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()
    }

    private static func cliDeleteKey(service: String, account: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["delete-generic-password", "-s", service, "-a", account]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()
    }
}
