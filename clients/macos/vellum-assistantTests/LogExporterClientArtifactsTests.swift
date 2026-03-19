import Foundation
import Testing
@testable import VellumAssistantLib

@Suite("LogExporterClientArtifactsTests")
struct LogExporterClientArtifactsTests {

    // MARK: - Helpers

    /// Creates a temporary directory tree mimicking the Application Support
    /// `vellum-assistant/` layout and returns the source and destination URLs.
    /// The caller must remove both directories when done.
    private func makeTempDirs() throws -> (source: URL, dest: URL) {
        let fm = FileManager.default
        let base = fm.temporaryDirectory
            .appendingPathComponent("log-exporter-test-\(UUID().uuidString)", isDirectory: true)
        let source = base.appendingPathComponent("source", isDirectory: true)
        let dest = base.appendingPathComponent("dest", isDirectory: true)
        try fm.createDirectory(at: source, withIntermediateDirectories: true)
        try fm.createDirectory(at: dest, withIntermediateDirectories: true)
        return (source, dest)
    }

    private func cleanup(_ urls: URL...) {
        let fm = FileManager.default
        for url in urls {
            // Walk up to the common parent (the base temp dir)
            try? fm.removeItem(at: url.deletingLastPathComponent())
        }
    }

    // MARK: - All Artifacts Present

    @Test
    func collectsAllClientArtifactsWhenPresent() throws {
        let (source, dest) = try makeTempDirs()
        defer { cleanup(source) }
        let fm = FileManager.default

        // Create session logs directory with JSONL files
        let logsDir = source.appendingPathComponent("logs", isDirectory: true)
        try fm.createDirectory(at: logsDir, withIntermediateDirectories: true)
        try "event1\n".write(
            to: logsDir.appendingPathComponent("chat-diagnostics-2025-01-01T00-00-00-1234.jsonl"),
            atomically: true, encoding: .utf8
        )
        try "event2\n".write(
            to: logsDir.appendingPathComponent("chat-diagnostics-2025-01-02T00-00-00-5678.jsonl"),
            atomically: true, encoding: .utf8
        )

        // Create debug-state.json
        try "{\"timestamp\":\"2025-01-01\"}".write(
            to: source.appendingPathComponent("debug-state.json"),
            atomically: true, encoding: .utf8
        )

        // Create hang-context.json
        try "{\"stallDurationSeconds\":3.5}".write(
            to: source.appendingPathComponent("hang-context.json"),
            atomically: true, encoding: .utf8
        )

        // Create hang-sample files
        try "sample data 1".write(
            to: source.appendingPathComponent("hang-sample.txt"),
            atomically: true, encoding: .utf8
        )
        try "sample data 2".write(
            to: source.appendingPathComponent("hang-sample-2.txt"),
            atomically: true, encoding: .utf8
        )

        // Run the collector
        LogExporter.collectClientArtifacts(from: source, into: dest, fileManager: fm)

        // Verify session logs were copied
        let sessionLogsDir = dest.appendingPathComponent("session-logs", isDirectory: true)
        #expect(fm.fileExists(atPath: sessionLogsDir.path))
        let sessionLogFiles = try fm.contentsOfDirectory(at: sessionLogsDir, includingPropertiesForKeys: nil)
        #expect(sessionLogFiles.count == 2)

        // Verify debug-state.json
        let debugStateDest = dest.appendingPathComponent("debug-state.json")
        #expect(fm.fileExists(atPath: debugStateDest.path))
        let debugStateContent = try String(contentsOf: debugStateDest, encoding: .utf8)
        #expect(debugStateContent.contains("timestamp"))

        // Verify hang-context.json
        let hangContextDest = dest.appendingPathComponent("hang-context.json")
        #expect(fm.fileExists(atPath: hangContextDest.path))
        let hangContextContent = try String(contentsOf: hangContextDest, encoding: .utf8)
        #expect(hangContextContent.contains("stallDurationSeconds"))

        // Verify hang-sample files
        let hangSampleDest = dest.appendingPathComponent("hang-sample.txt")
        #expect(fm.fileExists(atPath: hangSampleDest.path))
        let hangSample2Dest = dest.appendingPathComponent("hang-sample-2.txt")
        #expect(fm.fileExists(atPath: hangSample2Dest.path))
    }

    // MARK: - Graceful Degradation: No Hang Artifacts

    @Test
    func succeedsWhenHangArtifactsAreMissing() throws {
        let (source, dest) = try makeTempDirs()
        defer { cleanup(source) }
        let fm = FileManager.default

        // Create only session logs and debug-state (no hang artifacts)
        let logsDir = source.appendingPathComponent("logs", isDirectory: true)
        try fm.createDirectory(at: logsDir, withIntermediateDirectories: true)
        try "event\n".write(
            to: logsDir.appendingPathComponent("chat-diagnostics-2025-01-01T00-00-00-9999.jsonl"),
            atomically: true, encoding: .utf8
        )
        try "{\"timestamp\":\"2025-01-01\"}".write(
            to: source.appendingPathComponent("debug-state.json"),
            atomically: true, encoding: .utf8
        )

        // Run the collector — should not throw
        LogExporter.collectClientArtifacts(from: source, into: dest, fileManager: fm)

        // Session logs and debug-state should be copied
        #expect(fm.fileExists(atPath: dest.appendingPathComponent("session-logs").path))
        #expect(fm.fileExists(atPath: dest.appendingPathComponent("debug-state.json").path))

        // Hang artifacts should not exist in dest
        #expect(!fm.fileExists(atPath: dest.appendingPathComponent("hang-context.json").path))
        #expect(!fm.fileExists(atPath: dest.appendingPathComponent("hang-sample.txt").path))
    }

    // MARK: - Graceful Degradation: Only Hang Context

    @Test
    func collectsHangContextWithoutSampleFiles() throws {
        let (source, dest) = try makeTempDirs()
        defer { cleanup(source) }
        let fm = FileManager.default

        // Create hang-context.json but no sample files
        try "{\"stallDurationSeconds\":2.1}".write(
            to: source.appendingPathComponent("hang-context.json"),
            atomically: true, encoding: .utf8
        )

        LogExporter.collectClientArtifacts(from: source, into: dest, fileManager: fm)

        #expect(fm.fileExists(atPath: dest.appendingPathComponent("hang-context.json").path))
        #expect(!fm.fileExists(atPath: dest.appendingPathComponent("hang-sample.txt").path))
    }

    // MARK: - Graceful Degradation: Only Sample Files

    @Test
    func collectsSampleFilesWithoutHangContext() throws {
        let (source, dest) = try makeTempDirs()
        defer { cleanup(source) }
        let fm = FileManager.default

        // Create hang-sample files but no hang-context.json
        try "sample output".write(
            to: source.appendingPathComponent("hang-sample.txt"),
            atomically: true, encoding: .utf8
        )

        LogExporter.collectClientArtifacts(from: source, into: dest, fileManager: fm)

        #expect(!fm.fileExists(atPath: dest.appendingPathComponent("hang-context.json").path))
        #expect(fm.fileExists(atPath: dest.appendingPathComponent("hang-sample.txt").path))
    }

    // MARK: - Empty Source Directory

    @Test
    func succeedsWhenSourceDirectoryIsEmpty() throws {
        let (source, dest) = try makeTempDirs()
        defer { cleanup(source) }
        let fm = FileManager.default

        // Source exists but is empty — should not throw
        LogExporter.collectClientArtifacts(from: source, into: dest, fileManager: fm)

        // Destination should have no artifact files
        let destContents = try fm.contentsOfDirectory(
            at: dest, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]
        )
        #expect(destContents.isEmpty)
    }

    // MARK: - Nonexistent Source Directory

    @Test
    func succeedsWhenSourceDirectoryDoesNotExist() throws {
        let fm = FileManager.default
        let base = fm.temporaryDirectory
            .appendingPathComponent("log-exporter-noexist-\(UUID().uuidString)", isDirectory: true)
        let source = base.appendingPathComponent("nonexistent", isDirectory: true)
        let dest = base.appendingPathComponent("dest", isDirectory: true)
        try fm.createDirectory(at: dest, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: base) }

        // Source does not exist — should not throw
        LogExporter.collectClientArtifacts(from: source, into: dest, fileManager: fm)

        let destContents = try fm.contentsOfDirectory(
            at: dest, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]
        )
        #expect(destContents.isEmpty)
    }

    // MARK: - Non-Matching Files Are Ignored

    @Test
    func ignoresNonMatchingFilesInSourceDirectory() throws {
        let (source, dest) = try makeTempDirs()
        defer { cleanup(source) }
        let fm = FileManager.default

        // Create files that should NOT be collected
        try "not a hang sample".write(
            to: source.appendingPathComponent("hang-sample.json"),  // wrong extension
            atomically: true, encoding: .utf8
        )
        try "not a hang sample".write(
            to: source.appendingPathComponent("sample.txt"),  // wrong prefix
            atomically: true, encoding: .utf8
        )
        try "some data".write(
            to: source.appendingPathComponent("other-file.txt"),
            atomically: true, encoding: .utf8
        )

        // Also create a valid hang-sample file for contrast
        try "valid sample".write(
            to: source.appendingPathComponent("hang-sample.txt"),
            atomically: true, encoding: .utf8
        )

        LogExporter.collectClientArtifacts(from: source, into: dest, fileManager: fm)

        // Only the valid hang-sample file should be copied (not the others)
        #expect(fm.fileExists(atPath: dest.appendingPathComponent("hang-sample.txt").path))
        #expect(!fm.fileExists(atPath: dest.appendingPathComponent("hang-sample.json").path))
        #expect(!fm.fileExists(atPath: dest.appendingPathComponent("sample.txt").path))
        #expect(!fm.fileExists(atPath: dest.appendingPathComponent("other-file.txt").path))
    }

    // MARK: - Multiple Session Log Files

    @Test
    func collectsMultipleSessionLogFiles() throws {
        let (source, dest) = try makeTempDirs()
        defer { cleanup(source) }
        let fm = FileManager.default

        let logsDir = source.appendingPathComponent("logs", isDirectory: true)
        try fm.createDirectory(at: logsDir, withIntermediateDirectories: true)

        // Create several session log files
        for i in 0..<5 {
            try "event-\(i)\n".write(
                to: logsDir.appendingPathComponent("chat-diagnostics-2025-01-0\(i + 1)T00-00-00-\(1000 + i).jsonl"),
                atomically: true, encoding: .utf8
            )
        }

        LogExporter.collectClientArtifacts(from: source, into: dest, fileManager: fm)

        let sessionLogsDir = dest.appendingPathComponent("session-logs", isDirectory: true)
        let copied = try fm.contentsOfDirectory(at: sessionLogsDir, includingPropertiesForKeys: nil)
        #expect(copied.count == 5)
    }

    // MARK: - File Content Integrity

    @Test
    func preservesFileContentDuringCopy() throws {
        let (source, dest) = try makeTempDirs()
        defer { cleanup(source) }
        let fm = FileManager.default

        let hangContextContent = """
        {
            "stallStartTime": "2025-06-01T12:00:00Z",
            "stallDurationSeconds": 7.3,
            "pid": 12345,
            "appVersion": "1.2.3",
            "recentDiagnosticEvents": [],
            "transcriptSnapshots": []
        }
        """
        try hangContextContent.write(
            to: source.appendingPathComponent("hang-context.json"),
            atomically: true, encoding: .utf8
        )

        let sampleContent = "Analysis of sampling vellum-assistant (pid 12345) every 1 millisecond\nCall graph:\n  Thread_0\n"
        try sampleContent.write(
            to: source.appendingPathComponent("hang-sample.txt"),
            atomically: true, encoding: .utf8
        )

        LogExporter.collectClientArtifacts(from: source, into: dest, fileManager: fm)

        let copiedHangContext = try String(
            contentsOf: dest.appendingPathComponent("hang-context.json"), encoding: .utf8
        )
        #expect(copiedHangContext == hangContextContent)

        let copiedSample = try String(
            contentsOf: dest.appendingPathComponent("hang-sample.txt"), encoding: .utf8
        )
        #expect(copiedSample == sampleContent)
    }
}
