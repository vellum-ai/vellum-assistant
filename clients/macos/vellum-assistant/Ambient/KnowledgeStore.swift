import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "KnowledgeStore")

struct KnowledgeEntry: Codable, Identifiable {
    let id: UUID
    let timestamp: Date
    let category: String
    let observation: String
    let sourceApp: String
    let confidence: Double
}

struct KnowledgeFile: Codable {
    let version: Int
    var entries: [KnowledgeEntry]
}

final class KnowledgeStore {
    private let maxEntries = 500
    private var knowledge: KnowledgeFile
    private let fileURL: URL

    init() {
        let fileManager = FileManager.default
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = appSupport.appendingPathComponent("vellum-assistant", isDirectory: true)
        self.fileURL = dir.appendingPathComponent("knowledge.json")

        // Load existing knowledge or start fresh
        if let data = try? Data(contentsOf: fileURL),
           let file = try? JSONDecoder.iso8601Decoder.decode(KnowledgeFile.self, from: data) {
            self.knowledge = file
            log.info("Loaded \(file.entries.count) knowledge entries")
        } else {
            self.knowledge = KnowledgeFile(version: 1, entries: [])
        }
    }

    var entries: [KnowledgeEntry] { knowledge.entries }

    var recentEntries: [KnowledgeEntry] {
        Array(knowledge.entries.suffix(10))
    }

    func addEntry(category: String, observation: String, sourceApp: String, confidence: Double) {
        let entry = KnowledgeEntry(
            id: UUID(),
            timestamp: Date(),
            category: category,
            observation: observation,
            sourceApp: sourceApp,
            confidence: confidence
        )
        knowledge.entries.append(entry)

        // Prune oldest entries if over limit
        if knowledge.entries.count > maxEntries {
            knowledge.entries.removeFirst(knowledge.entries.count - maxEntries)
        }

        save()
        log.info("Added knowledge entry: \(observation.prefix(80))")
    }

    func clearAll() {
        knowledge.entries.removeAll()
        save()
        log.info("Cleared all knowledge entries")
    }

    private func save() {
        do {
            let dir = fileURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = .prettyPrinted
            let data = try encoder.encode(knowledge)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            log.error("Failed to save knowledge: \(error.localizedDescription)")
        }
    }

    func formattedContext() -> String {
        guard !knowledge.entries.isEmpty else {
            return "No observations yet."
        }

        return recentEntries.map { entry in
            "[\(entry.category)] \(entry.observation) (from: \(entry.sourceApp), confidence: \(String(format: "%.1f", entry.confidence)))"
        }.joined(separator: "\n")
    }
}

private extension JSONDecoder {
    static let iso8601Decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
