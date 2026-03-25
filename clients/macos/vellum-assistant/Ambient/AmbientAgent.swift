import Foundation
import VellumAssistantShared
import AppKit
import Combine
import UserNotifications
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AmbientAgent")

@MainActor
@Observable
public final class AmbientAgent {
    @ObservationIgnored let knowledgeStore = KnowledgeStore()
    @ObservationIgnored var connectionManager: GatewayConnectionManager?
    weak var appDelegate: AppDelegate?

    /// When a WatchSession is active (from chat-initiated watch), capture is skipped.
    /// Tracked (not @ObservationIgnored) because PanelCoordinator and ThreadWindow
    /// read this property for watch progress UI.
    var activeWatchSession: WatchSession?

    @ObservationIgnored private var cancellables = Set<AnyCancellable>()

    var knowledge: KnowledgeStore { knowledgeStore }

    func pause() {}
    func resume() {}
    func teardown() {
        activeWatchSession?.stop()
        activeWatchSession = nil
    }
}
