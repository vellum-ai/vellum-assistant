import Foundation

/// Pure routing decision produced from a `vellum://send` deep link URL.
/// Kept separate from `AppDelegate+BundleHandling` so the parsing and
/// dispatch logic can be unit-tested without pulling in AppKit, the
/// gateway connection, or main-window plumbing.
enum DeepLinkRoutingDecision: Equatable {
    /// URL is malformed, has the wrong host, or carries an empty `message`.
    case ignore
    /// No `assistant` query param — route the message to whatever the
    /// active assistant currently is (existing behavior).
    case routeToActive(message: String)
    /// An `assistant` param was present but did not match any entry in the
    /// lockfile. The caller should log a warning and still deliver the
    /// message to the active assistant (graceful degradation).
    case routeToActiveAfterUnknownAssistant(requestedAssistantId: String, message: String)
    /// `assistant` param matched a lockfile entry and the
    /// `multi-platform-assistant` flag is enabled — perform a live SSE
    /// switch to the requested assistant, then deliver the message.
    case switchLive(assistantId: String, message: String)
    /// `assistant` param matched a lockfile entry but the
    /// `multi-platform-assistant` flag is disabled. In this case we do
    /// **not** mutate `activeAssistant` — doing so would desync the
    /// per-request HTTP routing (which re-reads the lockfile) from the
    /// live SSE connection (which stays pinned to the old assistant until
    /// a full reconnect), causing sends to go to one assistant while
    /// replies come back on another. Instead we log the requested id and
    /// deliver the message to whatever is currently active. A true
    /// cross-assistant switch waits until multi-platform-assistant ships.
    case routeToActiveFlagOff(requestedAssistantId: String, message: String)
}

enum DeepLinkRouter {
    /// Parse a `vellum://send` URL and decide how to route it.
    ///
    /// - Parameters:
    ///   - url: The incoming URL (typically from `application(_:open:)`).
    ///   - knownAssistantIds: Ids currently present in the lockfile.
    ///   - multiAssistantEnabled: Whether `multi-platform-assistant` is on.
    static func decide(
        url: URL,
        knownAssistantIds: Set<String>,
        multiAssistantEnabled: Bool
    ) -> DeepLinkRoutingDecision {
        guard url.host == "send" else { return .ignore }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let messageItem = components.queryItems?.first(where: { $0.name == "message" }),
              let message = messageItem.value, !message.isEmpty else {
            return .ignore
        }

        let requestedAssistantId = components.queryItems?
            .first(where: { $0.name == "assistant" })?
            .value

        guard let requestedAssistantId, !requestedAssistantId.isEmpty else {
            return .routeToActive(message: message)
        }

        guard knownAssistantIds.contains(requestedAssistantId) else {
            return .routeToActiveAfterUnknownAssistant(
                requestedAssistantId: requestedAssistantId,
                message: message
            )
        }

        if multiAssistantEnabled {
            return .switchLive(assistantId: requestedAssistantId, message: message)
        } else {
            return .routeToActiveFlagOff(requestedAssistantId: requestedAssistantId, message: message)
        }
    }
}
