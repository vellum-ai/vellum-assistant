import Foundation

struct FixtureContext {
    let teardown: () -> Void
}

func setupFixture(_ fixtureName: String, appDisplayName: String) throws -> FixtureContext {
    switch fixtureName {
    case "desktop-app":
        return try createDesktopAppFixture(appDisplayName: appDisplayName)
    default:
        throw FixtureError.unknownFixture(fixtureName)
    }
}

private func createDesktopAppFixture(appDisplayName: String) throws -> FixtureContext {
    // Resolve app path relative to the runner location
    let cwd = FileManager.default.currentDirectoryPath
    let appDir: String
    if cwd.contains("agent-xcode") {
        // Running from playwright/agent-xcode/
        appDir = (cwd as NSString).appendingPathComponent("../../clients/macos/dist")
    } else if cwd.contains("playwright") {
        // Running from playwright/
        appDir = (cwd as NSString).appendingPathComponent("../clients/macos/dist")
    } else {
        appDir = (cwd as NSString).appendingPathComponent("clients/macos/dist")
    }

    let appPath = (appDir as NSString).appendingPathComponent("\(appDisplayName).app")
    let resolvedPath = (appPath as NSString).standardizingPath

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
        // Quit the app on teardown
        let quit = Process()
        quit.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        quit.arguments = ["-e", "tell application \"\(appDisplayName)\" to quit"]
        try? quit.run()
        quit.waitUntilExit()
    })
}

enum FixtureError: LocalizedError {
    case unknownFixture(String)
    case appNotFound(String)

    var errorDescription: String? {
        switch self {
        case .unknownFixture(let name): return "Unknown fixture: \(name)"
        case .appNotFound(let path): return "Built macOS app not found at: \(path)"
        }
    }
}
