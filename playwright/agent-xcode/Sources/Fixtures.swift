import Foundation

struct FixtureContext {
    let teardown: () -> Void
}

func setupFixture(_ fixtureName: String, appDisplayName: String) throws -> FixtureContext {
    switch fixtureName {
    case "desktop-app":
        return try createDesktopAppFixture(appDisplayName: appDisplayName)
    case "desktop-app-hatched":
        return try createDesktopAppHatchedFixture(appDisplayName: appDisplayName)
    default:
        throw FixtureError.unknownFixture(fixtureName)
    }
}

private func createDesktopAppFixture(appDisplayName: String) throws -> FixtureContext {
    let resolvedPath = resolveAppPath(appDisplayName: appDisplayName)

    guard FileManager.default.fileExists(atPath: resolvedPath) else {
        throw FixtureError.appNotFound(resolvedPath)
    }

    // Clear previous onboarding state
    let clearDefaults = Process()
    clearDefaults.executableURL = URL(fileURLWithPath: "/usr/bin/defaults")
    clearDefaults.arguments = ["delete", "com.vellum.vellum-assistant"]
    try? clearDefaults.run()
    clearDefaults.waitUntilExit()

    return FixtureContext(teardown: {
        retireAssistant()
        quitApp(appDisplayName: appDisplayName)
    })
}

/// Fixture for tests that assume an assistant is already hatched.
/// Skips clearing onboarding state so the desktop app opens straight
/// to the already-hatched assistant instead of showing the setup flow.
private func createDesktopAppHatchedFixture(appDisplayName: String) throws -> FixtureContext {
    let resolvedPath = resolveAppPath(appDisplayName: appDisplayName)

    guard FileManager.default.fileExists(atPath: resolvedPath) else {
        throw FixtureError.appNotFound(resolvedPath)
    }

    // Verify an assistant is already hatched
    let ps = Process()
    ps.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    ps.arguments = ["vellum", "ps"]
    let pipe = Pipe()
    ps.standardOutput = pipe
    ps.standardError = FileHandle.nullDevice
    try ps.run()
    ps.waitUntilExit()

    guard ps.terminationStatus == 0 else {
        throw FixtureError.noHatchedAssistant("vellum ps exited with status \(ps.terminationStatus)")
    }

    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    let output = String(data: data, encoding: .utf8) ?? ""
    let rows = output.split(separator: "\n")
        .map { String($0) }
        .filter { !$0.isEmpty && !$0.contains("NAME") && !$0.hasPrefix("  -") }

    guard !rows.isEmpty else {
        throw FixtureError.noHatchedAssistant("vellum ps returned no assistant rows.\nOutput:\n\(output)")
    }

    return FixtureContext(teardown: {
        retireAssistant()
        quitApp(appDisplayName: appDisplayName)
    })
}

// MARK: - Shared Helpers

private func resolveAppPath(appDisplayName: String) -> String {
    let cwd = FileManager.default.currentDirectoryPath
    let appDir: String
    if cwd.contains("agent-xcode") {
        appDir = (cwd as NSString).appendingPathComponent("../../clients/macos/dist")
    } else if cwd.contains("playwright") {
        appDir = (cwd as NSString).appendingPathComponent("../clients/macos/dist")
    } else {
        appDir = (cwd as NSString).appendingPathComponent("clients/macos/dist")
    }
    let appPath = (appDir as NSString).appendingPathComponent("\(appDisplayName).app")
    return (appPath as NSString).standardizingPath
}

private func retireAssistant() {
    let ps = Process()
    ps.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    ps.arguments = ["vellum", "ps"]
    let pipe = Pipe()
    ps.standardOutput = pipe
    ps.standardError = FileHandle.nullDevice
    do {
        try ps.run()
        ps.waitUntilExit()
    } catch {
        return
    }

    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    let output = String(data: data, encoding: .utf8) ?? ""
    let rows = output.split(separator: "\n")
        .map { String($0).trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty && !$0.contains("NAME") && !$0.hasPrefix("-") }

    guard let firstRow = rows.first else { return }
    let columns = firstRow.split(separator: " ", maxSplits: 1).map { String($0) }
    guard let assistantName = columns.first, !assistantName.isEmpty else { return }

    let retire = Process()
    retire.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    retire.arguments = ["vellum", "retire", assistantName]
    try? retire.run()
    retire.waitUntilExit()
}

private func quitApp(appDisplayName: String) {
    let quit = Process()
    quit.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    quit.arguments = ["-e", "tell application \"\(appDisplayName)\" to quit"]
    try? quit.run()
    quit.waitUntilExit()
}

enum FixtureError: LocalizedError {
    case unknownFixture(String)
    case appNotFound(String)
    case noHatchedAssistant(String)

    var errorDescription: String? {
        switch self {
        case .unknownFixture(let name): return "Unknown fixture: \(name)"
        case .appNotFound(let path): return "Built macOS app not found at: \(path)"
        case .noHatchedAssistant(let detail): return "No hatched assistant found — \(detail)"
        }
    }
}
