import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "InsightStore")

enum InsightCategory: String, Codable {
    case pattern
    case automation
    case insight
}

struct KnowledgeInsight: Codable, Identifiable {
    let id: UUID
    let timestamp: Date
    let category: InsightCategory
    let title: String
    let description: String
    let confidence: Double
    var dismissed: Bool
}

struct InsightsFile: Codable {
    let version: Int
    var insights: [KnowledgeInsight]
}

final class InsightStore: ObservableObject {
    private let maxInsights = 50
    @Published private var file: InsightsFile
    private let fileURL: URL

    init() {
        let fileManager = FileManager.default
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = appSupport.appendingPathComponent("vellum-assistant", isDirectory: true)
        self.fileURL = dir.appendingPathComponent("insights.json")

        if let data = try? Data(contentsOf: fileURL),
           let loaded = try? JSONDecoder.iso8601Decoder.decode(InsightsFile.self, from: data) {
            self.file = loaded
            log.info("Loaded \(loaded.insights.count) insights")
        } else {
            self.file = InsightsFile(version: 1, insights: [])
        }
    }

    var insights: [KnowledgeInsight] { file.insights }

    var insightCount: Int { file.insights.count }

    func addInsights(_ newInsights: [KnowledgeInsight]) {
        for insight in newInsights {
            // Dedup: skip if an existing insight has a very similar title
            let isDuplicate = file.insights.contains { existing in
                ScreenOCR.similarity(existing.title, insight.title) > 0.7
            }
            guard !isDuplicate else {
                log.debug("Skipping duplicate insight: \(insight.title.prefix(60))")
                continue
            }
            file.insights.append(insight)
        }

        // FIFO pruning
        if file.insights.count > maxInsights {
            file.insights.removeFirst(file.insights.count - maxInsights)
        }

        save()
    }

    func dismissInsight(id: UUID) {
        guard let idx = file.insights.firstIndex(where: { $0.id == id }) else { return }
        file.insights[idx].dismissed = true
        save()
    }

    func clearAll() {
        file.insights.removeAll()
        save()
        log.info("Cleared all insights")
    }

    private func save() {
        do {
            let dir = fileURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = .prettyPrinted
            let data = try encoder.encode(file)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            log.error("Failed to save insights: \(error.localizedDescription)")
        }
    }
}

private extension JSONDecoder {
    static let iso8601Decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
