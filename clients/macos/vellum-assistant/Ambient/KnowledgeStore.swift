import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "KnowledgeStore")

struct KnowledgeEntry: Codable, Identifiable {
    let id: UUID
    let timestamp: Date
    let category: String
    let observation: String
    let sourceApp: String
    let confidence: Double
    var windowTitle: String?
    var focusedElement: String?
    var captureMethod: String?
    var bundleIdentifier: String?
}

struct KnowledgeFile: Codable {
    let version: Int
    var entries: [KnowledgeEntry]
}

final class KnowledgeStore: ObservableObject {
    private let maxEntries = 500
    @Published private var knowledge: KnowledgeFile
    private let fileURL: URL

    var onEntryAdded: ((KnowledgeEntry) -> Void)?

    init() {
        let fileManager = FileManager.default
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = appSupport.appendingPathComponent(VellumEnvironment.current.appSupportDirectoryName, isDirectory: true)
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

    var entryCount: Int { knowledge.entries.count }

    func entriesSince(_ date: Date) -> [KnowledgeEntry] {
        knowledge.entries.filter { $0.timestamp >= date }
    }

    var recentEntries: [KnowledgeEntry] {
        Array(knowledge.entries.suffix(10))
    }

    func addEntry(category: String, observation: String, sourceApp: String, confidence: Double,
                  windowTitle: String? = nil, focusedElement: String? = nil,
                  captureMethod: String? = nil, bundleIdentifier: String? = nil) {
        // Dedup: skip if a recent entry has a very similar observation
        let recentWindow = knowledge.entries.suffix(20)
        let isDuplicate = recentWindow.contains { existing in
            ScreenOCR.similarity(existing.observation, observation) > 0.7
        }
        if isDuplicate {
            log.debug("Skipping duplicate observation: \(observation.prefix(80))")
            return
        }

        var entry = KnowledgeEntry(
            id: UUID(),
            timestamp: Date(),
            category: category,
            observation: observation,
            sourceApp: sourceApp,
            confidence: confidence
        )
        entry.windowTitle = windowTitle
        entry.focusedElement = focusedElement
        entry.captureMethod = captureMethod
        entry.bundleIdentifier = bundleIdentifier
        knowledge.entries.append(entry)

        // Prune oldest entries if over limit
        if knowledge.entries.count > maxEntries {
            knowledge.entries.removeFirst(knowledge.entries.count - maxEntries)
        }

        save()
        log.info("Added knowledge entry: \(observation.prefix(80))")
        onEntryAdded?(entry)
    }

    func removeEntry(id: UUID) {
        knowledge.entries.removeAll { $0.id == id }
        save()
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
