import SwiftUI

@MainActor
@Observable
final class ZoomManager {
    static let zoomSteps: [CGFloat] = [0.50, 0.60, 0.70, 0.75, 0.80, 0.90, 1.00, 1.10, 1.25, 1.50, 1.75, 2.00]

    var zoomLevel: CGFloat {
        didSet { UserDefaults.standard.set(zoomLevel, forKey: "windowZoomLevel") }
    }
    var showZoomIndicator = false

    private var dismissTask: Task<Void, Never>?

    var zoomPercentage: Int {
        Int(round(zoomLevel * 100))
    }

    init() {
        let stored = UserDefaults.standard.double(forKey: "windowZoomLevel")
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
