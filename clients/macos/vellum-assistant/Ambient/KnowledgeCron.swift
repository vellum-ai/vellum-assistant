import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "KnowledgeCron")

@MainActor
final class KnowledgeCron {
    let insightStore = InsightStore()
    private let knowledgeStore: KnowledgeStore
    private var client: AnthropicClient?
    private let model = "claude-haiku-4-5-20251001"
    private let observationsPerRun = 5
    private let maxConsecutiveFailures = 3
    private var consecutiveFailures = 0
    private var observationsSinceLastRun = 0
    private var analysisTask: Task<Void, Never>?

    var onInsight: ((KnowledgeInsight) -> Void)?
    var onInsightsAdded: (([KnowledgeInsight]) -> Void)?

    private var lastRunTimestamp: TimeInterval {
        get { UserDefaults.standard.double(forKey: "knowledgeCronLastRun") }
        set { UserDefaults.standard.set(newValue, forKey: "knowledgeCronLastRun") }
    }

    init(knowledgeStore: KnowledgeStore) {
        self.knowledgeStore = knowledgeStore
    }

    func start(apiKey: String) {
        client = AnthropicClient(apiKey: apiKey)
        observationsSinceLastRun = 0
        log.info("Knowledge insight analyzer started (every \(self.observationsPerRun) observations)")
    }

    func stop() {
        analysisTask?.cancel()
        analysisTask = nil
        client = nil
        log.info("Knowledge insight analyzer stopped")
    }

    func observationAdded() {
        observationsSinceLastRun += 1
        log.debug("Observations since last insight run: \(self.observationsSinceLastRun)/\(self.observationsPerRun)")

        guard observationsSinceLastRun >= observationsPerRun else { return }
        guard analysisTask == nil else { return }

        observationsSinceLastRun = 0
        analysisTask = Task { @MainActor [weak self] in
            await self?.runAnalysis()
            self?.analysisTask = nil
        }
    }

    private func runAnalysis() async {
        guard let client = client else { return }

        let lastRunDate = Date(timeIntervalSince1970: lastRunTimestamp)
        let recentEntries = lastRunTimestamp > 0
            ? knowledgeStore.entriesSince(lastRunDate)
            : knowledgeStore.entries

        guard !recentEntries.isEmpty else {
            log.debug("Cron: no entries since last run")
            lastRunTimestamp = Date().timeIntervalSince1970
            return
        }

        log.info("Cron: analyzing \(recentEntries.count) entries")

        let entriesText = recentEntries.map { entry in
            "[\(entry.category)] \(entry.observation) (app: \(entry.sourceApp), confidence: \(String(format: "%.1f", entry.confidence)), time: \(ISO8601DateFormatter().string(from: entry.timestamp)))"
        }.joined(separator: "\n")

        let systemPrompt = """
        You are analyzing a batch of observations about a user's computer behavior collected over time. \
        Your goal is to find patterns, recurring behaviors, and opportunities for automation or workflow improvements.

        Look for:
        - Recurring patterns (same apps, same workflows, same times)
        - Automation opportunities (repetitive tasks that could be scripted)
        - Workflow insights (bottlenecks, context-switching patterns, focus periods)

        Be specific and actionable. Only report findings you are genuinely confident about.
        """

        let userMessage = """
        RECENT OBSERVATIONS:
        \(entriesText)

        BACKGROUND CONTEXT:
        \(knowledgeStore.formattedContext())

        Analyze these observations and report any interesting patterns, automation opportunities, or insights.
        """

        let toolDefinition: [String: Any] = [
            "name": "report_insights",
            "description": "Report patterns, automation opportunities, or workflow insights discovered from analyzing user behavior observations.",
            "input_schema": [
                "type": "object",
                "required": ["insights"],
                "properties": [
                    "insights": [
                        "type": "array",
                        "description": "List of insights discovered from the observations. May be empty if nothing notable was found.",
                        "items": [
                            "type": "object",
                            "required": ["category", "title", "description", "confidence"],
                            "properties": [
                                "category": [
                                    "type": "string",
                                    "enum": ["pattern", "automation", "insight"],
                                    "description": "Type of finding: pattern (recurring behavior), automation (task that could be automated), insight (workflow observation)"
                                ],
                                "title": [
                                    "type": "string",
                                    "description": "Short title summarizing the finding (under 80 chars)"
                                ],
                                "description": [
                                    "type": "string",
                                    "description": "Detailed description of the finding and any recommendations"
                                ],
                                "confidence": [
                                    "type": "number",
                                    "description": "How confident you are in this finding (0.0 to 1.0)"
                                ]
                            ]
                        ]
                    ]
                ]
            ]
        ]

        do {
            let result = try await client.sendToolUseRequest(
                model: model,
                maxTokens: 1024,
                system: systemPrompt,
                tools: [toolDefinition],
                toolChoice: ["type": "any"],
                messages: [
                    ["role": "user", "content": userMessage]
                ],
                timeout: 30
            )

            guard let rawInsights = result.input["insights"] as? [[String: Any]] else {
                log.warning("Cron: failed to parse insights from response, advancing watermark (deterministic failure)")
                consecutiveFailures = 0
                lastRunTimestamp = Date().timeIntervalSince1970
                return
            }

            let insights = rawInsights.compactMap { raw -> KnowledgeInsight? in
                guard let categoryStr = raw["category"] as? String,
                      let category = InsightCategory(rawValue: categoryStr),
                      let title = raw["title"] as? String,
                      let description = raw["description"] as? String,
                      let confidence = raw["confidence"] as? Double else {
                    return nil
                }
                return KnowledgeInsight(
                    id: UUID(),
                    timestamp: Date(),
                    category: category,
                    title: title,
                    description: description,
                    confidence: confidence,
                    dismissed: false
                )
            }

            if !insights.isEmpty {
                insightStore.addInsights(insights)
                log.info("Cron: added \(insights.count) insights")
                onInsightsAdded?(insights)

                // Fire callback for the highest-confidence insight
                if let best = insights.max(by: { $0.confidence < $1.confidence }) {
                    onInsight?(best)
                }
            } else {
                log.info("Cron: no insights found in this run")
            }

            consecutiveFailures = 0
            lastRunTimestamp = Date().timeIntervalSince1970

        } catch {
            log.warning("Cron: analysis failed: \(error.localizedDescription)")
            advanceOrRetry()
        }
    }

    /// Increment failure counter; advance watermark after repeated failures to avoid
    /// getting permanently stuck on a deterministic error (e.g. payload too large).
    private func advanceOrRetry() {
        consecutiveFailures += 1
        if consecutiveFailures >= maxConsecutiveFailures {
            log.warning("Cron: \(self.consecutiveFailures) consecutive failures, advancing watermark to avoid stuck retry loop")
            consecutiveFailures = 0
            lastRunTimestamp = Date().timeIntervalSince1970
        }
    }
}
