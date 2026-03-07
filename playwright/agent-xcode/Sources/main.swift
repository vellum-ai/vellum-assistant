import Foundation

// MARK: - CLI Entry Point

func main() async {
    let args = CommandLine.arguments
    let verbose = args.contains("--verbose")
    let testFilterArg = args.firstIndex(of: "--filter").flatMap { idx in
        idx + 1 < args.count ? args[idx + 1] : nil
    }
    let testFilter: TestStatus = {
        if args.contains("--experimental") {
            return .experimental
        }
        if let raw = testFilterArg ?? ProcessInfo.processInfo.environment["TEST_FILTER"] {
            return TestStatus(rawValue: raw.lowercased()) ?? .stable
        }
        return .stable
    }()
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
    var results: [(name: String, passed: Bool, message: String, reasoning: String, durationMs: Int)] = []
    var skipped: [String] = []

    for testCase in testCases {
        let statusPriority: [TestStatus: Int] = [.critical: 0, .stable: 1, .experimental: 2]
        let effectiveStatus = testCase.status ?? .stable
        if statusPriority[effectiveStatus, default: 1] > statusPriority[testFilter, default: 2] {
            skipped.append(testCase.name)
            print("⏭ Skipping (\(effectiveStatus.rawValue)): \(testCase.name)")
            continue
        }

        // Check required env vars
        if let requiredEnv = testCase.requiredEnv {
            let missing = requiredEnv.filter { ProcessInfo.processInfo.environment[$0] == nil }
            if !missing.isEmpty {
                skipped.append(testCase.name)
                print("⏭ Skipping (missing env: \(missing.joined(separator: ", "))): \(testCase.name)")
                continue
            }
        }

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
            results.append((name: testCase.name, passed: result.passed, message: result.message, reasoning: result.reasoning, durationMs: durationMs))

            let icon = result.passed ? "✓" : "✗"
            let duration = String(format: "%.1f", Double(durationMs) / 1000.0)
            print("  \(icon) \(testCase.name) (\(duration)s)")
            if !result.passed {
                print("    \(result.message)")
                if !result.reasoning.isEmpty {
                    print("    Reasoning: \(result.reasoning)")
                }
            }
            print()
        } catch {
            let durationMs = Int(Date().timeIntervalSince(startTime) * 1000)
            results.append((name: testCase.name, passed: false, message: "Runner error: \(error.localizedDescription)", reasoning: "An unexpected error occurred in the runner before the agent could report a result.", durationMs: durationMs))
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
    var summaryParts = ["\(passed) passed", "\(failed) failed"]
    if !skipped.isEmpty {
        summaryParts.append("\(skipped.count) skipped")
    }
    print("Results: \(summaryParts.joined(separator: ", ")) (\(String(format: "%.1f", Double(totalDuration) / 1000.0))s total)")
    print(String(repeating: "─", count: 60))

    // Write JSON test report for artifact consumption
    let reportDir = (casesDir as NSString).appendingPathComponent("../../test-results")
    let resolvedReportDir = (reportDir as NSString).standardizingPath
    try? FileManager.default.createDirectory(atPath: resolvedReportDir, withIntermediateDirectories: true)
    let report: [[String: Any]] = results.map { r in
        [
            "name": r.name,
            "passed": r.passed,
            "message": r.message,
            "reasoning": r.reasoning,
            "durationMs": r.durationMs,
        ]
    }
    if let jsonData = try? JSONSerialization.data(withJSONObject: ["tests": report], options: [.prettyPrinted, .sortedKeys]) {
        let reportPath = (resolvedReportDir as NSString).appendingPathComponent("test-report.json")
        try? jsonData.write(to: URL(fileURLWithPath: reportPath))
    }

    exit(failed > 0 ? 1 : 0)
}

// Run the async main
let semaphore = DispatchSemaphore(value: 0)
Task {
    await main()
    semaphore.signal()
}
semaphore.wait()
