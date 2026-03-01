import Foundation

// MARK: - CLI Entry Point

func main() async {
    let args = CommandLine.arguments
    let verbose = args.contains("--verbose")
    let filter = args.first(where: { !$0.starts(with: "--") && $0 != args[0] })
    let appDisplayName = ProcessInfo.processInfo.environment["APP_DISPLAY_NAME"] ?? "Vellum"

    // Check accessibility permission
    guard ActionExecutor.checkAccessibilityPermission() else {
        print("ERROR: Accessibility permission not granted.")
        print("Grant permission in System Settings > Privacy & Security > Accessibility")
        exit(1)
    }

    // Discover test cases
    let scriptPath = URL(fileURLWithPath: args[0]).deletingLastPathComponent().path
    let casesDir: String
    if scriptPath.contains(".build") {
        // Running from .build/release or .build/debug — go up to playwright/cases
        let agentXcodeDir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        casesDir = agentXcodeDir.appendingPathComponent("../cases").standardized.path
    } else {
        casesDir = (scriptPath as NSString).appendingPathComponent("../cases")
    }

    let testCases = discoverTestCases(casesDir: casesDir, filter: filter)

    if testCases.isEmpty {
        print("No test cases found in \(casesDir)")
        exit(0)
    }

    print("\nFound \(testCases.count) test case(s)\(filter != nil ? " matching \"\(filter!)\"" : ""):\n")
    for tc in testCases {
        let fixtureInfo = tc.fixture != nil ? " [fixture: \(tc.fixture!)]" : ""
        print("  - \(tc.name)\(fixtureInfo)")
    }
    print()

    // Run tests
    var results: [(name: String, passed: Bool, message: String, durationMs: Int)] = []

    for testCase in testCases {
        print("▶ Running: \(testCase.name)")
        let startTime = Date()

        var fixtureCtx: FixtureContext?

        do {
            // Setup fixture
            if let fixtureName = testCase.fixture {
                fixtureCtx = try setupFixture(fixtureName, appDisplayName: appDisplayName)
            }

            // Parse content
            let parsed = parseFrontmatter(testCase.rawContent)

            // Run agent
            let result = try await runAgent(options: AgentOptions(
                testContent: parsed.body,
                appName: appDisplayName,
                verbose: verbose
            ))

            let durationMs = Int(Date().timeIntervalSince(startTime) * 1000)
            results.append((name: testCase.name, passed: result.passed, message: result.message, durationMs: durationMs))

            let icon = result.passed ? "✓" : "✗"
            let duration = String(format: "%.1f", Double(durationMs) / 1000.0)
            print("  \(icon) \(testCase.name) (\(duration)s)")
            if !result.passed {
                print("    \(result.message)")
            }
            print()
        } catch {
            let durationMs = Int(Date().timeIntervalSince(startTime) * 1000)
            results.append((name: testCase.name, passed: false, message: "Runner error: \(error.localizedDescription)", durationMs: durationMs))
            let duration = String(format: "%.1f", Double(durationMs) / 1000.0)
            print("  ✗ \(testCase.name) (\(duration)s)")
            print("    Runner error: \(error.localizedDescription)")
            print()
        }

        // Teardown fixture
        fixtureCtx?.teardown()
    }

    // Summary
    let passed = results.filter { $0.passed }.count
    let failed = results.filter { !$0.passed }.count
    let totalDuration = results.reduce(0) { $0 + $1.durationMs }

    print(String(repeating: "─", count: 60))
    print("Results: \(passed) passed, \(failed) failed (\(String(format: "%.1f", Double(totalDuration) / 1000.0))s total)")
    print(String(repeating: "─", count: 60))

    exit(failed > 0 ? 1 : 0)
}

// Run the async main
let semaphore = DispatchSemaphore(value: 0)
Task {
    await main()
    semaphore.signal()
}
semaphore.wait()
