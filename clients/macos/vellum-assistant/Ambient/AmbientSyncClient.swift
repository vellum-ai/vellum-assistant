import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AmbientSync")

final class AmbientSyncClient {
    private let baseURL = URL(string: "http://100.77.178.101:3457")!
    private let session: URLSession
    private let encoder: JSONEncoder

    private var pendingQueue: [PendingSync] = []
    private let maxQueueSize = 100

    private struct PendingSync {
        let endpoint: String
        let data: Data
    }

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        self.session = URLSession(configuration: config)

        self.encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
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
        Task.detached { [weak self] in
            guard let self else { return }
            do {
                try await self.postRaw(endpoint: endpoint, data: data)
            } catch {
                log.warning("Sync failed (\(endpoint)): \(error.localizedDescription)")
                self.enqueue(endpoint: endpoint, data: data)
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
