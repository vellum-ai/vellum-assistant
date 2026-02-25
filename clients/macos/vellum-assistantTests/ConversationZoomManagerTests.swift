import Foundation
import Testing
@testable import VellumAssistantLib

@Suite("ConversationZoomManager")
struct ConversationZoomManagerTests {

    // MARK: - Default State

    @Test @MainActor
    func defaultZoomLevelIsOne() {
        // Clear any persisted value so the manager starts fresh.
        UserDefaults.standard.removeObject(forKey: "conversationTextZoomLevel")
        let manager = ConversationZoomManager()
        #expect(manager.zoomLevel == 1.0)
        #expect(manager.zoomPercentage == 100)
    }

    // MARK: - Zoom In

    @Test @MainActor
    func zoomInAdvancesToNextStep() {
        UserDefaults.standard.removeObject(forKey: "conversationTextZoomLevel")
        let manager = ConversationZoomManager()
        manager.zoomIn()
        #expect(manager.zoomLevel == 1.1)
        #expect(manager.zoomPercentage == 110)
    }

    @Test @MainActor
    func zoomInMultipleSteps() {
        UserDefaults.standard.removeObject(forKey: "conversationTextZoomLevel")
        let manager = ConversationZoomManager()
        manager.zoomIn() // 1.1
        manager.zoomIn() // 1.25
        manager.zoomIn() // 1.5
        #expect(manager.zoomLevel == 1.5)
        #expect(manager.zoomPercentage == 150)
    }

    // MARK: - Zoom Out

    @Test @MainActor
    func zoomOutRetreatsToLowerStep() {
        UserDefaults.standard.removeObject(forKey: "conversationTextZoomLevel")
        let manager = ConversationZoomManager()
        manager.zoomOut()
        #expect(manager.zoomLevel == 0.9)
        #expect(manager.zoomPercentage == 90)
    }

    @Test @MainActor
    func zoomOutMultipleSteps() {
        UserDefaults.standard.removeObject(forKey: "conversationTextZoomLevel")
        let manager = ConversationZoomManager()
        manager.zoomOut() // 0.9
        manager.zoomOut() // 0.75
        manager.zoomOut() // 0.5
        #expect(manager.zoomLevel == 0.5)
        #expect(manager.zoomPercentage == 50)
    }

    // MARK: - Clamping at Maximum

    @Test @MainActor
    func zoomInClampsAtMaximum() {
        UserDefaults.standard.removeObject(forKey: "conversationTextZoomLevel")
        let manager = ConversationZoomManager()
        let maxStep = ConversationZoomManager.zoomSteps.last!

        // Zoom in until we hit the maximum step.
        for _ in 0..<ConversationZoomManager.zoomSteps.count {
            manager.zoomIn()
        }
        #expect(manager.zoomLevel == maxStep)

        // One more zoomIn should not change the level.
        manager.zoomIn()
        #expect(manager.zoomLevel == maxStep)
        #expect(manager.zoomPercentage == Int(round(maxStep * 100)))
    }

    // MARK: - Clamping at Minimum

    @Test @MainActor
    func zoomOutClampsAtMinimum() {
        UserDefaults.standard.removeObject(forKey: "conversationTextZoomLevel")
        let manager = ConversationZoomManager()
        let minStep = ConversationZoomManager.zoomSteps.first!

        // Zoom out until we hit the minimum step.
        for _ in 0..<ConversationZoomManager.zoomSteps.count {
            manager.zoomOut()
        }
        #expect(manager.zoomLevel == minStep)

        // One more zoomOut should not change the level.
        manager.zoomOut()
        #expect(manager.zoomLevel == minStep)
        #expect(manager.zoomPercentage == Int(round(minStep * 100)))
    }

    // MARK: - Reset Zoom

    @Test @MainActor
    func resetZoomRestoresDefault() {
        UserDefaults.standard.removeObject(forKey: "conversationTextZoomLevel")
        let manager = ConversationZoomManager()
        manager.zoomIn()
        manager.zoomIn()
        #expect(manager.zoomLevel != 1.0)

        manager.resetZoom()
        #expect(manager.zoomLevel == 1.0)
        #expect(manager.zoomPercentage == 100)
    }

    @Test @MainActor
    func resetZoomFromZoomedOut() {
        UserDefaults.standard.removeObject(forKey: "conversationTextZoomLevel")
        let manager = ConversationZoomManager()
        manager.zoomOut()
        manager.zoomOut()
        #expect(manager.zoomLevel < 1.0)

        manager.resetZoom()
        #expect(manager.zoomLevel == 1.0)
    }

    // MARK: - Persistence

    @Test @MainActor
    func zoomLevelPersistsAcrossInstances() {
        let key = "conversationTextZoomLevel"
        UserDefaults.standard.removeObject(forKey: key)

        let first = ConversationZoomManager()
        first.zoomIn() // 1.1
        first.zoomIn() // 1.25
        let savedLevel = first.zoomLevel

        // A second instance should load the persisted value.
        let second = ConversationZoomManager()
        #expect(second.zoomLevel == savedLevel)
        #expect(second.zoomPercentage == Int(round(savedLevel * 100)))

        // Clean up.
        UserDefaults.standard.removeObject(forKey: key)
    }

    @Test @MainActor
    func resetZoomPersists() {
        let key = "conversationTextZoomLevel"
        UserDefaults.standard.removeObject(forKey: key)

        let first = ConversationZoomManager()
        first.zoomIn()
        first.resetZoom()

        let second = ConversationZoomManager()
        #expect(second.zoomLevel == 1.0)

        UserDefaults.standard.removeObject(forKey: key)
    }

    // MARK: - Indicator Flashing

    @Test @MainActor
    func zoomInShowsIndicator() {
        UserDefaults.standard.removeObject(forKey: "conversationTextZoomLevel")
        let manager = ConversationZoomManager()
        #expect(!manager.showZoomIndicator)

        manager.zoomIn()
        #expect(manager.showZoomIndicator)
    }

    @Test @MainActor
    func zoomOutShowsIndicator() {
        UserDefaults.standard.removeObject(forKey: "conversationTextZoomLevel")
        let manager = ConversationZoomManager()
        manager.zoomOut()
        #expect(manager.showZoomIndicator)
    }

    @Test @MainActor
    func resetZoomShowsIndicator() {
        UserDefaults.standard.removeObject(forKey: "conversationTextZoomLevel")
        let manager = ConversationZoomManager()
        manager.resetZoom()
        #expect(manager.showZoomIndicator)
    }

    @Test @MainActor
    func indicatorAutoDismisses() async {
        UserDefaults.standard.removeObject(forKey: "conversationTextZoomLevel")
        let manager = ConversationZoomManager()
        manager.zoomIn()
        #expect(manager.showZoomIndicator)

        // Wait for the 1.5s auto-dismiss plus a small buffer.
        try? await Task.sleep(nanoseconds: 1_800_000_000)
        #expect(!manager.showZoomIndicator)
    }

    // MARK: - Zoom Steps Invariants

    @Test
    func zoomStepsAreSortedAscending() {
        let steps = ConversationZoomManager.zoomSteps
        for i in 1..<steps.count {
            #expect(steps[i] > steps[i - 1])
        }
    }

    @Test
    func zoomStepsContainDefaultLevel() {
        #expect(ConversationZoomManager.zoomSteps.contains(1.0))
    }
}
