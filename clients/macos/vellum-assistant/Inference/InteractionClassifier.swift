import NaturalLanguage
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "InteractionClassifier")

struct InteractionClassifier {
    private let embedding: NLEmbedding
    private let computerUseVectors: [[Double]]
    private let textQAVectors: [[Double]]

    private static let computerUsePhrases = [
        "open safari", "click the button", "type hello in the search box",
        "scroll down", "navigate to settings", "switch to notes app",
        "drag the file", "close this window", "fill out the form",
        "send an email", "create a new document", "delete this file",
        "copy the text", "paste it here", "go to google.com",
        "launch terminal", "press enter", "select all text",
        "move the window", "submit the form",
    ]

    private static let textQAPhrases = [
        "what time is my next meeting", "what's on my calendar",
        "tell me about the weather", "how do I reset my password",
        "who sent me the last email", "explain how this works",
        "what are my tasks for today", "hey how's it going",
        "hi there", "good morning", "thanks for the help",
        "summarize my schedule", "when is the deadline",
        "why is the build failing", "describe this error",
        "list my recent notifications", "is it going to rain today",
        "what does this mean", "can you help me understand", "how are you",
    ]

    /// Top-K nearest references to average when scoring each category.
    private static let topK = 3

    /// If the best category's average distance exceeds this, default to textQA.
    private static let distanceThreshold: Double = 1.2

    init?() {
        let languageCode = Locale.current.language.languageCode?.identifier ?? "en"
        let nlLanguage = NLLanguage(rawValue: languageCode)

        let language: NLLanguage
        if NLEmbedding.sentenceEmbedding(for: nlLanguage) != nil {
            language = nlLanguage
        } else {
            language = .english
        }

        guard let emb = NLEmbedding.sentenceEmbedding(for: language) else {
            log.error("No sentence embedding available for \(language.rawValue)")
            return nil
        }

        self.embedding = emb
        self.computerUseVectors = Self.computerUsePhrases.compactMap { emb.vector(for: $0) }
        self.textQAVectors = Self.textQAPhrases.compactMap { emb.vector(for: $0) }

        let cuCount = self.computerUseVectors.count
        let qaCount = self.textQAVectors.count
        log.info("InteractionClassifier ready (lang=\(language.rawValue), cuRefs=\(cuCount), qaRefs=\(qaCount))")
    }

    func classify(_ input: String) -> InteractionType {
        guard let inputVec = embedding.vector(for: input) else {
            log.warning("No embedding vector for input, defaulting to textQA")
            return .textQA
        }

        let cuDistances = computerUseVectors.map { cosineDistance(inputVec, $0) }.sorted()
        let qaDistances = textQAVectors.map { cosineDistance(inputVec, $0) }.sorted()

        let cuScore = averageTopK(cuDistances)
        let qaScore = averageTopK(qaDistances)

        log.debug("classify: cuScore=\(cuScore, format: .fixed(precision: 4)) qaScore=\(qaScore, format: .fixed(precision: 4)) input=\"\(input)\"")

        // If both are above threshold, default to textQA (safer/cheaper)
        if min(cuScore, qaScore) > Self.distanceThreshold {
            return .textQA
        }

        return cuScore < qaScore ? .computerUse : .textQA
    }

    // MARK: - Math

    private func averageTopK(_ sortedDistances: [Double]) -> Double {
        let k = min(Self.topK, sortedDistances.count)
        guard k > 0 else { return Double.infinity }
        return sortedDistances.prefix(k).reduce(0, +) / Double(k)
    }

    private func cosineDistance(_ a: [Double], _ b: [Double]) -> Double {
        var dot = 0.0, normA = 0.0, normB = 0.0
        for i in 0..<a.count {
            dot += a[i] * b[i]
            normA += a[i] * a[i]
            normB += b[i] * b[i]
        }
        let denom = sqrt(normA) * sqrt(normB)
        guard denom > 0 else { return 2.0 }
        return 1.0 - (dot / denom)
    }
}
