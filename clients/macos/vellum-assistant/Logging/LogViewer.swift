import os
import SwiftUI
import VellumAssistantShared
import Foundation

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "LogViewer")

struct LogViewer: View {
    @State private var logFiles: [URL] = []
    @State private var selectedLog: SessionLog?

    var body: some View {
        NavigationSplitView {
            List(logFiles, id: \.absoluteString, selection: Binding(
                get: { nil as URL? },
                set: { url in
                    if let url = url { loadLog(url) }
                }
            )) { url in
                Text(url.lastPathComponent)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }
            .navigationTitle("Session Logs")
        } detail: {
            if let log = selectedLog {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Task: \(log.task)")
                            .font(.headline)
                        Text("Result: \(log.result)")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Text("Steps: \(log.turns.count)")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

                        Divider()

                        ForEach(log.turns, id: \.step) { turn in
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Step \(turn.step)")
                                    .font(.caption.bold())
                                Text(turn.action.displayDescription)
                                    .font(.caption)
                                if turn.usedVision {
                                    Text("(vision fallback)")
                                        .font(.caption2)
                                        .foregroundStyle(VColor.systemNegativeHover)
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                    .padding()
                    .textSelection(.enabled)
                }
            } else {
                Text("Select a log file")
                    .foregroundStyle(.secondary)
            }
        }
        .onAppear { loadLogFiles() }
    }

    private func loadLogFiles() {
        let fileManager = FileManager.default
        guard let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return }
        let logDir = appSupport.appendingPathComponent("vellum-assistant/logs", isDirectory: true)

        do {
            let files = try fileManager.contentsOfDirectory(at: logDir, includingPropertiesForKeys: [.contentModificationDateKey])
                .filter { $0.pathExtension == "json" }
                .sorted { $0.lastPathComponent > $1.lastPathComponent }
            logFiles = files
        } catch {
            logFiles = []
        }
    }

    private func loadLog(_ url: URL) {
        do {
            let data = try Data(contentsOf: url)
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            selectedLog = try decoder.decode(SessionLog.self, from: data)
        } catch {
            log.error("Failed to load log: \(error)")
        }
    }
}
