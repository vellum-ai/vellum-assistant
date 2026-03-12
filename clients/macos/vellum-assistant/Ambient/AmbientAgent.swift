import Foundation
import VellumAssistantShared
import AppKit
import Combine
import UserNotifications
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AmbientAgent")

@MainActor
public final class AmbientAgent: ObservableObject {
    let knowledgeStore = KnowledgeStore()
    var daemonClient: DaemonClient?
    weak var appDelegate: AppDelegate?

    /// When a WatchSession is active (from chat-initiated watch), capture is skipped.
    var activeWatchSession: WatchSession?

    private var cancellables = Set<AnyCancellable>()

    var knowledge: KnowledgeStore { knowledgeStore }

    func pause() {}
    func resume() {}
    func teardown() {}
}
