import SwiftUI

/// Manages conversation-level text zoom (Cmd +/-/0), independent of the
/// window-level zoom handled by `ZoomManager`.
///
/// The scale factor is applied to chat text surfaces (messages, markdown,
/// code blocks, composer) via the `conversationZoomScale` environment value.
/// Zoom level persists across app relaunches via `@AppStorage`.
@MainActor
@Observable
final class ConversationZoomManager {
    nonisolated static let zoomSteps: [CGFloat] = [0.5, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0]

    var zoomLevel: CGFloat {
        didSet { UserDefaults.standard.set(zoomLevel, forKey: "conversationTextZoomLevel") }
    }
    var showZoomIndicator = false

    private var dismissTask: Task<Void, Never>?

    var zoomPercentage: Int {
        Int(round(zoomLevel * 100))
    }

    init() {
        let stored = UserDefaults.standard.double(forKey: "conversationTextZoomLevel")
        self.zoomLevel = stored > 0 ? stored : 1.0
    }

    func zoomIn() {
        if let next = Self.zoomSteps.first(where: { $0 > zoomLevel + 0.001 }) {
            zoomLevel = next
            flashIndicator()
        }
    }

    func zoomOut() {
        if let prev = Self.zoomSteps.last(where: { $0 < zoomLevel - 0.001 }) {
            zoomLevel = prev
            flashIndicator()
        }
    }

    func resetZoom() {
        zoomLevel = 1.0
        flashIndicator()
    }

    private func flashIndicator() {
        dismissTask?.cancel()
        showZoomIndicator = true
        dismissTask = Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled else { return }
            showZoomIndicator = false
        }
    }
}

// MARK: - SwiftUI Environment

private struct ConversationZoomScaleKey: EnvironmentKey {
    static let defaultValue: CGFloat = 1.0
}

extension EnvironmentValues {
    /// The conversation text zoom scale factor. Chat text surfaces multiply
    /// their base font sizes by this value to implement conversation zoom.
    var conversationZoomScale: CGFloat {
        get { self[ConversationZoomScaleKey.self] }
        set { self[ConversationZoomScaleKey.self] = newValue }
    }
}
