import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AmbientSync")

actor AmbientSyncClient {
    private let baseURL: URL
    private let session: URLSession
    private let encoder: JSONEncoder

    private var pendingQueue: [PendingSync] = []
    private let maxQueueSize = 100

    private struct PendingSync {
        let endpoint: String
        let data: Data
    }

    init(baseURL: URL? = nil) {
        if let baseURL {
            self.baseURL = baseURL
        } else if let envURL = ProcessInfo.processInfo.environment["AMBIENT_SYNC_URL"] {
            let normalized = envURL.hasPrefix("http://") || envURL.hasPrefix("https://")
                ? envURL
                : "http://\(envURL)"
            if let parsed = URL(string: normalized), parsed.host != nil {
                self.baseURL = parsed
            } else {
                log.error("AMBIENT_SYNC_URL is set but contains an invalid URL: '\(envURL)' — sync client disabled")
                self.baseURL = URL(string: "http://localhost:0")!
            }
        } else {
            log.warning("AMBIENT_SYNC_URL not set — sync client disabled")
            self.baseURL = URL(string: "http://localhost:0")!
        }

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        self.session = URLSession(configuration: config)

        self.encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601

        log.info("Sync base URL: \(self.baseURL.absoluteString)")
    }

    // MARK: - Health Check

    func checkHealth() async -> Bool {
        let url = baseURL.appendingPathComponent("api/health")
        do {
            let (_, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse else { return false }
            let healthy = http.statusCode == 200
            log.info("Health check: \(healthy ? "OK" : "FAIL (status \(http.statusCode))")")
            return healthy
        } catch {
            log.warning("Health check failed: \(error.localizedDescription)")
            return false
        }
    }

    // MARK: - Send Methods

    func sendObservation(_ entry: KnowledgeEntry) {
        encodeThenSend(endpoint: "api/observation", body: entry)
    }

    func sendObservations(_ entries: [KnowledgeEntry]) {
        guard !entries.isEmpty else { return }
        encodeThenSend(endpoint: "api/observations", body: ObservationBatchPayload(entries: entries))
    }

    func sendInsight(_ insight: KnowledgeInsight) {
        encodeThenSend(endpoint: "api/insight", body: insight)
    }

    func sendInsights(_ insights: [KnowledgeInsight]) {
        guard !insights.isEmpty else { return }
        encodeThenSend(endpoint: "api/insights", body: InsightBatchPayload(entries: insights))
    }

    func sendAnalysis(_ result: AmbientAnalysisResult) {
        encodeThenSend(endpoint: "api/analysis", body: result)
    }

    func sendDecision(_ decision: AutomationDecision) {
        encodeThenSend(endpoint: "api/decision", body: decision)
    }

    // MARK: - Batch Sync (on launch)

    func syncExisting(observations: [KnowledgeEntry], insights: [KnowledgeInsight]) {
        sendObservations(observations)
        sendInsights(insights)
    }

    // MARK: - Retry Queue

    func flushQueue() {
        let items = pendingQueue
        pendingQueue.removeAll()
        for item in items {
            postAsync(endpoint: item.endpoint, data: item.data)
        }
    }

    // MARK: - Internal

    private func encodeThenSend<T: Encodable>(endpoint: String, body: T) {
        guard let data = try? encoder.encode(body) else {
            log.warning("Failed to encode payload for \(endpoint)")
            return
        }
        postAsync(endpoint: endpoint, data: data)
    }

    private func postAsync(endpoint: String, data: Data) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.postRaw(endpoint: endpoint, data: data)
            } catch {
                log.warning("Sync failed (\(endpoint)): \(error.localizedDescription)")
                await self.enqueue(endpoint: endpoint, data: data)
            }
        }
    }

    private func postRaw(endpoint: String, data: Data) async throws {
        let url = baseURL.appendingPathComponent(endpoint)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = data

        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw SyncError.httpError(status)
        }
    }

    private func enqueue(endpoint: String, data: Data) {
        if pendingQueue.count >= maxQueueSize {
            pendingQueue.removeFirst()
        }
        pendingQueue.append(PendingSync(endpoint: endpoint, data: data))
    }

    private struct ObservationBatchPayload: Encodable {
        let entries: [KnowledgeEntry]
    }

    private struct InsightBatchPayload: Encodable {
        let entries: [KnowledgeInsight]
    }

    private enum SyncError: Error, LocalizedError {
        case httpError(Int)

        var errorDescription: String? {
            switch self {
            case .httpError(let code): return "HTTP \(code)"
            }
        }
    }
}

struct AutomationDecision: Encodable {
    let insightId: String
    let insightTitle: String
    let description: String
    let schedule: String
    let approved: Bool
    let source: String
}
