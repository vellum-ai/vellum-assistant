import AppKit
import Foundation
import Observation
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "HomeFeedStore")

/// Wire-format wrapper returned by `GET /v1/home/feed`.
private struct HomeFeedResponse: Decodable {
    let items: [FeedItem]
    let lastUpdated: String?
}

/// Observable store that owns home feed state and refreshes on SSE events
/// or app foreground transitions.
///
/// Uses `GatewayHTTPClient` (stateless enum) for HTTP requests and subscribes
/// to the gateway's `EventStreamClient` for real-time `home_feed_updated` pushes.
@MainActor
@Observable
final class HomeFeedStore {

    // MARK: - Observable State

    var items: [FeedItem] = []
    var lastUpdated: Date?
    var isLoading = false
    var error: String?

    // MARK: - Filtered Views

    var nudges: [FeedItem] { items.filter { $0.type == .nudge && $0.status != .actedOn } }
    var digests: [FeedItem] { items.filter { $0.type == .digest } }
    var actions: [FeedItem] { items.filter { $0.type == .action } }
    var threads: [FeedItem] { items.filter { $0.type == .thread } }
    var newCount: Int { items.filter { $0.status == .new }.count }

    // MARK: - Persisted Session Tracking

    /// The date the user last ended a session (app went to background).
    /// Persisted across launches via UserDefaults.
    var lastSessionDate: Date? {
        didSet {
            if let lastSessionDate {
                UserDefaults.standard.set(lastSessionDate.timeIntervalSince1970, forKey: Self.lastSessionDateDefaultsName)
            }
        }
    }

    @ObservationIgnored private static let lastSessionDateDefaultsName = "homeFeedLastSessionDate"

    // MARK: - Dependencies

    @ObservationIgnored private let eventStreamClient: EventStreamClient
    @ObservationIgnored private var sseTask: Task<Void, Never>?
    @ObservationIgnored private var foregroundObserver: NSObjectProtocol?
    @ObservationIgnored private var backgroundObserver: NSObjectProtocol?

    // MARK: - Init

    /// Creates a new store and starts listening for SSE and foreground events.
    ///
    /// The store does **not** perform an initial fetch — the caller is expected to
    /// call ``fetch()`` when the view appears (e.g. in `onAppear`), matching the
    /// pattern used by `DirectoryStore` and the home feed spec's `onAppear` trigger.
    init(eventStreamClient: EventStreamClient) {
        self.eventStreamClient = eventStreamClient

        // Restore persisted lastSessionDate
        let stored = UserDefaults.standard.double(forKey: Self.lastSessionDateDefaultsName)
        if stored > 0 {
            self.lastSessionDate = Date(timeIntervalSince1970: stored)
        }

        startSSESubscription()
        startForegroundObserver()
    }

    deinit {
        sseTask?.cancel()
        if let observer = foregroundObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        if let observer = backgroundObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
    }

    // MARK: - HTTP Methods

    /// Fetch the full feed from the gateway.
    func fetch() async {
        isLoading = true
        error = nil
        defer { isLoading = false }

        do {
            let (decoded, response): (HomeFeedResponse?, GatewayHTTPClient.Response) =
                try await GatewayHTTPClient.get(path: "assistants/{assistantId}/home/feed") { decoder in
                    decoder.dateDecodingStrategy = .iso8601
                    decoder.keyDecodingStrategy = .convertFromSnakeCase
                }

            if response.isSuccess, let decoded {
                items = decoded.items
                if let ts = decoded.lastUpdated {
                    let formatter = ISO8601DateFormatter()
                    lastUpdated = formatter.date(from: ts) ?? Date()
                } else {
                    lastUpdated = Date()
                }
            } else {
                let msg = "Failed to fetch feed (HTTP \(response.statusCode))"
                log.error("\(msg)")
                error = msg
            }
        } catch {
            let msg = "Feed fetch error: \(error.localizedDescription)"
            log.error("\(msg)")
            self.error = msg
        }
    }

    /// Mark a feed item as seen.
    func markSeen(_ id: String) async {
        do {
            let response = try await GatewayHTTPClient.patch(
                path: "assistants/{assistantId}/home/feed/\(id)",
                json: ["status": "seen"]
            )
            if response.isSuccess {
                if let idx = items.firstIndex(where: { $0.id == id }) {
                    items[idx].status = .seen
                }
            } else {
                log.error("markSeen failed (HTTP \(response.statusCode)) for item \(id)")
            }
        } catch {
            log.error("markSeen error: \(error.localizedDescription)")
        }
    }

    /// Dismiss a feed item (mark as acted_on).
    func dismiss(_ id: String) async {
        do {
            let response = try await GatewayHTTPClient.patch(
                path: "assistants/{assistantId}/home/feed/\(id)",
                json: ["status": "acted_on"]
            )
            if response.isSuccess {
                if let idx = items.firstIndex(where: { $0.id == id }) {
                    items[idx].status = .actedOn
                }
            } else {
                log.error("dismiss failed (HTTP \(response.statusCode)) for item \(id)")
            }
        } catch {
            log.error("dismiss error: \(error.localizedDescription)")
        }
    }

    /// Trigger a specific action on a feed item.
    func triggerAction(itemId: String, actionId: String) async {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/home/feed/\(itemId)/actions/\(actionId)",
                json: [:]
            )
            if response.isSuccess {
                // Refresh to pick up any server-side status changes
                await fetch()
            } else {
                log.error("triggerAction failed (HTTP \(response.statusCode)) for item \(itemId) action \(actionId)")
            }
        } catch {
            log.error("triggerAction error: \(error.localizedDescription)")
        }
    }

    // MARK: - SSE Subscription

    private func startSSESubscription() {
        sseTask = Task { [weak self] in
            guard let eventStreamClient = self?.eventStreamClient else { return }
            let stream = eventStreamClient.subscribe()
            for await message in stream {
                guard let self, !Task.isCancelled else { break }
                if case .homeFeedUpdated = message {
                    await self.fetch()
                }
            }
        }
    }

    // MARK: - App Foreground Observer

    private func startForegroundObserver() {
        // Refresh feed when our app comes to the foreground
        foregroundObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  app.bundleIdentifier == Bundle.appBundleIdentifier else {
                return
            }
            Task { @MainActor [weak self] in
                await self?.fetch()
            }
        }

        // Record lastSessionDate when our app goes to the background
        backgroundObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didDeactivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  app.bundleIdentifier == Bundle.appBundleIdentifier else {
                return
            }
            Task { @MainActor [weak self] in
                self?.lastSessionDate = Date()
            }
        }
    }
}
