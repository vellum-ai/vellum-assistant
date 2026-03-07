import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Baseline characterization tests locking the current dynamic-page preview behavior.
///
/// Dynamic pages with preview metadata render as compact inline preview cards in
/// the chat. Dynamic pages without preview metadata skip inline rendering on macOS
/// (they route to the full workspace instead). The workspace is opened via the
/// `.openDynamicWorkspace` NotificationCenter notification posted by AppDelegate.
///
/// These tests ensure media embed work does not regress this existing flow.
@MainActor
final class ChatDynamicPreviewRegressionTests: XCTestCase {

    private var daemonClient: DaemonClient!
    private var viewModel: ChatViewModel!

    override func setUp() {
        super.setUp()
        daemonClient = DaemonClient()
        daemonClient.isConnected = true
        daemonClient.sendOverride = { _ in }
        viewModel = ChatViewModel(daemonClient: daemonClient)
        viewModel.sessionId = "sess-dp"
    }

    override func tearDown() {
        viewModel = nil
        daemonClient = nil
        super.tearDown()
    }

    // MARK: - Helper: build a UiSurfaceShowMessage for a dynamic page

    private func makeDynamicPageSurfaceMessage(
        surfaceId: String = "surface-dp-1",
        title: String = "My App",
        html: String = "<h1>Hello</h1>",
        display: String? = nil,
        preview: [String: Any?]? = nil,
        appId: String? = nil
    ) -> UiSurfaceShowMessage {
        var dataDict: [String: Any?] = ["html": html]
        if let preview { dataDict["preview"] = preview }
        if let appId { dataDict["appId"] = appId }
        return UiSurfaceShowMessage(
            sessionId: "sess-dp",
            surfaceId: surfaceId,
            surfaceType: "dynamic_page",
            title: title,
            data: AnyCodable(dataDict),
            actions: nil,
            display: display,
            messageId: nil
        )
    }

    // MARK: - Dynamic page with preview metadata renders inline

    func testDynamicPageWithPreviewRendersInlinePreviewCard() {
        // Simulate assistant text, then a dynamic page surface with preview metadata
        viewModel.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "Here is your app:")
        ))

        let msg = makeDynamicPageSurfaceMessage(
            preview: ["title": "Weather App", "subtitle": "v1.0"]
        )
        viewModel.handleServerMessage(.uiSurfaceShow(msg))

        // The inline surface should be attached to the assistant message
        XCTAssertEqual(viewModel.messages.count, 1, "Should have one assistant message")
        let assistantMsg = viewModel.messages[0]
        XCTAssertEqual(assistantMsg.role, .assistant)
        XCTAssertEqual(assistantMsg.inlineSurfaces.count, 1,
                       "Dynamic page with preview should create an inline surface")

        let surface = assistantMsg.inlineSurfaces[0]
        XCTAssertEqual(surface.id, "surface-dp-1")
        XCTAssertEqual(surface.surfaceType, .dynamicPage)
        XCTAssertEqual(surface.title, "My App")

        // Verify the surface data is a dynamic page with preview
        if case .dynamicPage(let dpData) = surface.data {
            XCTAssertNotNil(dpData.preview, "Preview metadata should be present")
            XCTAssertEqual(dpData.preview?.title, "Weather App")
            XCTAssertEqual(dpData.preview?.subtitle, "v1.0")
        } else {
            XCTFail("Surface data should be a dynamic page")
        }
    }

    // MARK: - Dynamic page without preview skips inline rendering on macOS

    func testDynamicPageWithoutPreviewSkipsInlineOnMacOS() {
        viewModel.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "Built your app:")
        ))

        // No preview metadata and no display mode (defaults to panel routing)
        let msg = makeDynamicPageSurfaceMessage(preview: nil, appId: "app-123")
        viewModel.handleServerMessage(.uiSurfaceShow(msg))

        // On macOS, dynamic pages without preview metadata skip inline rendering
        let assistantMsg = viewModel.messages[0]
        XCTAssertTrue(assistantMsg.inlineSurfaces.isEmpty,
                      "Dynamic page without preview should not render inline on macOS")
    }

    func testDynamicPageWithPanelDisplayAndNoPreviewSkipsInline() {
        viewModel.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "Opening panel:")
        ))

        let msg = makeDynamicPageSurfaceMessage(display: "panel", preview: nil)
        viewModel.handleServerMessage(.uiSurfaceShow(msg))

        let assistantMsg = viewModel.messages[0]
        XCTAssertTrue(assistantMsg.inlineSurfaces.isEmpty,
                      "Panel-display dynamic page without preview should not render inline")
    }

    // MARK: - Dynamic page with display=inline always renders inline

    func testDynamicPageWithInlineDisplayRendersInline() {
        viewModel.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "Inline form:")
        ))

        // display=inline bypasses the preview check
        let msg = makeDynamicPageSurfaceMessage(display: "inline", preview: nil)
        viewModel.handleServerMessage(.uiSurfaceShow(msg))

        let assistantMsg = viewModel.messages[0]
        XCTAssertEqual(assistantMsg.inlineSurfaces.count, 1,
                       "display=inline should always render inline, even without preview")
    }

    // MARK: - Preview card hides text bubble while active

    func testPreviewCardHidesTextBubble() {
        // When inline surfaces are present and not completed, the text bubble
        // should be hidden (per shouldShowBubble logic in ChatView)
        let preview = DynamicPagePreview(title: "Test App", subtitle: nil, description: nil, icon: nil, metrics: nil)
        let dpData = DynamicPageSurfaceData(html: "<div>test</div>", preview: preview)
        let inlineSurface = InlineSurfaceData(
            id: "surf-1",
            surfaceType: .dynamicPage,
            title: "Test App",
            data: .dynamicPage(dpData),
            actions: []
        )
        let msg = ChatMessage(
            role: .assistant,
            text: "Here is your app:",
            inlineSurfaces: [inlineSurface]
        )

        // The message should have text but bubble is hidden because of active inline surfaces
        XCTAssertFalse(msg.inlineSurfaces.isEmpty,
                       "Message should have an inline surface")
        XCTAssertNil(msg.inlineSurfaces[0].completionState,
                     "Inline surface should not be completed yet")
        XCTAssertFalse(msg.text.isEmpty,
                       "Message should have text content")

        // Assert shouldShowBubble would return false: assistant message with
        // non-completed inline surfaces should hide the text bubble.
        let allCompleted = msg.inlineSurfaces.allSatisfy { $0.completionState != nil }
        XCTAssertFalse(allCompleted,
                       "Not all surfaces are completed, so shouldShowBubble should be false")
        let shouldShowBubble = allCompleted && (!msg.text.isEmpty || !msg.attachments.isEmpty)
        XCTAssertFalse(shouldShowBubble,
                       "Bubble should be hidden when assistant message has active inline surfaces")
    }

    // MARK: - Completed surface shows text bubble again

    func testCompletedSurfaceAllowsTextBubble() {
        let preview = DynamicPagePreview(title: "Test App", subtitle: nil, description: nil, icon: nil, metrics: nil)
        let dpData = DynamicPageSurfaceData(html: "<div>test</div>", preview: preview)
        let inlineSurface = InlineSurfaceData(
            id: "surf-2",
            surfaceType: .dynamicPage,
            title: "Test App",
            data: .dynamicPage(dpData),
            actions: [],
            completionState: SurfaceCompletionState(summary: "App created")
        )

        // When all surfaces are completed, the bubble should be shown again
        XCTAssertNotNil(inlineSurface.completionState,
                        "Surface should be in completed state")

        // Build a message with text and a completed surface, then verify
        // shouldShowBubble would return true.
        let msg = ChatMessage(
            role: .assistant,
            text: "Here is your app:",
            inlineSurfaces: [inlineSurface]
        )
        let allCompleted = msg.inlineSurfaces.allSatisfy { $0.completionState != nil }
        XCTAssertTrue(allCompleted,
                      "All surfaces are completed")
        let hasText = !msg.text.isEmpty
        let shouldShowBubble = allCompleted && (hasText || !msg.attachments.isEmpty)
        XCTAssertTrue(shouldShowBubble,
                      "Bubble should be shown when all inline surfaces are completed and message has text")
    }

    // MARK: - Workspace notification flow

    func testOpenDynamicWorkspaceNotificationFlow() {
        // Verify the notification name is correctly defined.
        let notificationName = Notification.Name.openDynamicWorkspace
        XCTAssertEqual(notificationName.rawValue, "MainWindow.openDynamicWorkspace",
                       "openDynamicWorkspace notification name should match expected value")

        // Verify that posting the notification is actually received by an observer.
        let expectation = expectation(description: "openDynamicWorkspace notification received")
        let observer = NotificationCenter.default.addObserver(
            forName: .openDynamicWorkspace,
            object: nil,
            queue: .main
        ) { notification in
            XCTAssertEqual(notification.name, .openDynamicWorkspace)
            expectation.fulfill()
        }
        defer { NotificationCenter.default.removeObserver(observer) }

        NotificationCenter.default.post(name: .openDynamicWorkspace, object: nil)
        wait(for: [expectation], timeout: 1.0)
    }

    func testUpdateDynamicWorkspaceNotificationDefined() {
        let notificationName = Notification.Name.updateDynamicWorkspace
        XCTAssertEqual(notificationName.rawValue, "MainWindow.updateDynamicWorkspace",
                       "updateDynamicWorkspace notification name should match expected value")

        // Verify the notification posting mechanism works.
        let expectation = expectation(description: "updateDynamicWorkspace notification received")
        let observer = NotificationCenter.default.addObserver(
            forName: .updateDynamicWorkspace,
            object: nil,
            queue: .main
        ) { notification in
            XCTAssertEqual(notification.name, .updateDynamicWorkspace)
            expectation.fulfill()
        }
        defer { NotificationCenter.default.removeObserver(observer) }

        NotificationCenter.default.post(name: .updateDynamicWorkspace, object: nil)
        wait(for: [expectation], timeout: 1.0)
    }

    func testDismissDynamicWorkspaceNotificationDefined() {
        let notificationName = Notification.Name.dismissDynamicWorkspace
        XCTAssertEqual(notificationName.rawValue, "MainWindow.dismissDynamicWorkspace",
                       "dismissDynamicWorkspace notification name should match expected value")

        // Verify the notification posting mechanism works.
        let expectation = expectation(description: "dismissDynamicWorkspace notification received")
        let observer = NotificationCenter.default.addObserver(
            forName: .dismissDynamicWorkspace,
            object: nil,
            queue: .main
        ) { notification in
            XCTAssertEqual(notification.name, .dismissDynamicWorkspace)
            expectation.fulfill()
        }
        defer { NotificationCenter.default.removeObserver(observer) }

        NotificationCenter.default.post(name: .dismissDynamicWorkspace, object: nil)
        wait(for: [expectation], timeout: 1.0)
    }

    // MARK: - Preview card rendering is independent from plain message link parsing

    func testDynamicPreviewDoesNotAffectPlainTextLinks() {
        // First, send a message with a URL (plain text)
        viewModel.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "Check https://example.com for details. ")
        ))

        // Then attach a dynamic page with preview
        let msg = makeDynamicPageSurfaceMessage(
            surfaceId: "surface-link-test",
            preview: ["title": "Dashboard"]
        )
        viewModel.handleServerMessage(.uiSurfaceShow(msg))

        XCTAssertEqual(viewModel.messages.count, 1)
        let assistantMsg = viewModel.messages[0]

        // URL should be preserved in the text, not converted to an embed
        XCTAssertTrue(assistantMsg.text.contains("https://example.com"),
                      "Plain URL in text should remain unchanged when a dynamic preview is present")

        // Dynamic page should be an inline surface, not derived from the URL
        XCTAssertEqual(assistantMsg.inlineSurfaces.count, 1)
        XCTAssertEqual(assistantMsg.inlineSurfaces[0].id, "surface-link-test",
                       "Inline surface should be the explicit dynamic page, not derived from the URL")

        // No attachments should be synthesized
        XCTAssertTrue(assistantMsg.attachments.isEmpty,
                      "No attachment should be synthesized from URL or preview")
    }

    func testPlainTextLinksUnchangedWithoutDynamicPreview() {
        // Verify that URLs in assistant messages are plain text even without
        // any dynamic page surface present — same behavior as before
        viewModel.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "Visit https://example.com/dashboard")
        ))
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertTrue(msg.text.contains("https://example.com/dashboard"),
                      "URL should be preserved as plain text")
        XCTAssertTrue(msg.inlineSurfaces.isEmpty,
                      "No inline surface should be auto-created from a URL")
        XCTAssertTrue(msg.attachments.isEmpty,
                      "No attachment should be synthesized from a URL")
    }

    // MARK: - Surface update flow

    func testSurfaceUpdateUpdatesInlinePreview() {
        // Attach a dynamic page with preview
        viewModel.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "Building app:")
        ))

        let showMsg = makeDynamicPageSurfaceMessage(
            surfaceId: "surface-update-test",
            preview: ["title": "v1"]
        )
        viewModel.handleServerMessage(.uiSurfaceShow(showMsg))
        XCTAssertEqual(viewModel.messages[0].inlineSurfaces.count, 1)

        // Update the surface with new preview data
        let updateMsg = UiSurfaceUpdateMessage(
            sessionId: "sess-dp",
            surfaceId: "surface-update-test",
            data: AnyCodable([
                "html": "<h1>Updated</h1>",
                "preview": ["title": "v2", "subtitle": "Updated"] as [String: Any]
            ] as [String: Any])
        )
        viewModel.handleServerMessage(.uiSurfaceUpdate(updateMsg))

        // The inline surface should be updated
        let updatedSurface = viewModel.messages[0].inlineSurfaces[0]
        if case .dynamicPage(let dpData) = updatedSurface.data {
            XCTAssertEqual(dpData.html, "<h1>Updated</h1>",
                           "Surface HTML should be updated")
            XCTAssertNotNil(dpData.preview, "Preview should still be present")
            XCTAssertEqual(dpData.preview?.title, "v2",
                           "Preview title should be updated")
        } else {
            XCTFail("Updated surface should still be a dynamic page")
        }
    }

    // MARK: - Surface dismiss flow

    func testSurfaceDismissRemovesInlinePreview() {
        viewModel.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "App:")
        ))

        let showMsg = makeDynamicPageSurfaceMessage(
            surfaceId: "surface-dismiss-test",
            preview: ["title": "Temp App"]
        )
        viewModel.handleServerMessage(.uiSurfaceShow(showMsg))
        XCTAssertEqual(viewModel.messages[0].inlineSurfaces.count, 1)

        let dismissMsg = UiSurfaceDismissMessage(
            type: "ui_surface_dismiss",
            sessionId: "sess-dp",
            surfaceId: "surface-dismiss-test"
        )
        viewModel.handleServerMessage(.uiSurfaceDismiss(dismissMsg))

        XCTAssertTrue(viewModel.messages[0].inlineSurfaces.isEmpty,
                      "Inline surface should be removed after dismiss")
    }

    // MARK: - Surface complete flow

    func testSurfaceCompleteSetsSurfaceCompletionState() {
        viewModel.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "Done:")
        ))

        let showMsg = makeDynamicPageSurfaceMessage(
            surfaceId: "surface-complete-test",
            preview: ["title": "Completed App"]
        )
        viewModel.handleServerMessage(.uiSurfaceShow(showMsg))
        XCTAssertNil(viewModel.messages[0].inlineSurfaces[0].completionState)

        let completeMsg = UiSurfaceCompleteMessage(
            sessionId: "sess-dp",
            surfaceId: "surface-complete-test",
            summary: "App created successfully",
            submittedData: nil
        )
        viewModel.handleServerMessage(.uiSurfaceComplete(completeMsg))

        let surface = viewModel.messages[0].inlineSurfaces[0]
        XCTAssertNotNil(surface.completionState,
                        "Surface should have completion state")
        XCTAssertEqual(surface.completionState?.summary, "App created successfully")
    }

    // MARK: - History hydration with surfaces

    func testPopulateFromHistoryWithDynamicPageSurface() {
        let surfaceData: [String: AnyCodable] = [
            "html": AnyCodable("<p>From history</p>"),
            "preview": AnyCodable([
                "title": "Restored App",
                "subtitle": "v3"
            ] as [String: Any])
        ]
        let historySurface = IPCHistoryResponseSurface(
            surfaceId: "hist-surface-1",
            surfaceType: "dynamic_page",
            title: "History App",
            data: surfaceData,
            actions: nil,
            display: nil
        )
        let historyItems: [IPCHistoryResponseMessage] = [
            IPCHistoryResponseMessage(
                id: nil,
                role: "assistant",
                text: "Here is your restored app",
                timestamp: 5000,
                toolCalls: nil,
                toolCallsBeforeText: nil,
                attachments: nil,
                textSegments: nil,
                contentOrder: nil,
                surfaces: [historySurface],
                subagentNotification: nil
            ),
        ]

        viewModel.populateFromHistory(historyItems)

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.role, .assistant)
        XCTAssertEqual(msg.inlineSurfaces.count, 1,
                       "History surface should be hydrated as an inline surface")
        XCTAssertEqual(msg.inlineSurfaces[0].id, "hist-surface-1")
        XCTAssertEqual(msg.inlineSurfaces[0].surfaceType, .dynamicPage)
    }

    func testPopulateFromHistoryWithLightModeSurface() {
        // Light-mode history strips html but preserves preview metadata.
        // The surface should still parse and render as an inline preview card.
        let surfaceData: [String: AnyCodable] = [
            "preview": AnyCodable([
                "title": "Slides",
                "subtitle": "5 pages"
            ] as [String: Any]),
            "appId": AnyCodable("app-light-1")
        ]
        let historySurface = IPCHistoryResponseSurface(
            surfaceId: "hist-light-surface",
            surfaceType: "dynamic_page",
            title: "Light Mode App",
            data: surfaceData,
            actions: nil,
            display: nil
        )
        let historyItems: [IPCHistoryResponseMessage] = [
            IPCHistoryResponseMessage(
                id: nil,
                role: "assistant",
                text: "Here are your slides",
                timestamp: 6000,
                toolCalls: nil,
                toolCallsBeforeText: nil,
                attachments: nil,
                textSegments: nil,
                contentOrder: nil,
                surfaces: [historySurface],
                subagentNotification: nil
            ),
        ]

        viewModel.populateFromHistory(historyItems)

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.inlineSurfaces.count, 1,
                       "Light-mode surface with preview should still hydrate as inline")
        let surface = msg.inlineSurfaces[0]
        XCTAssertEqual(surface.id, "hist-light-surface")
        if case .dynamicPage(let dpData) = surface.data {
            XCTAssertEqual(dpData.html, "",
                           "html should default to empty string when stripped by light mode")
            XCTAssertNotNil(dpData.preview, "Preview metadata should be preserved")
            XCTAssertEqual(dpData.preview?.title, "Slides")
            XCTAssertEqual(dpData.appId, "app-light-1")
        } else {
            XCTFail("Surface data should be a dynamic page")
        }
    }

    // MARK: - Surface content order tracking

    func testDynamicPreviewAppearsInContentOrder() {
        viewModel.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "Check it out:")
        ))

        let msg = makeDynamicPageSurfaceMessage(
            surfaceId: "surface-order-test",
            preview: ["title": "Ordered App"]
        )
        viewModel.handleServerMessage(.uiSurfaceShow(msg))

        let assistantMsg = viewModel.messages[0]
        // Content order should contain both the text segment and the surface
        XCTAssertTrue(assistantMsg.contentOrder.contains(.text(0)),
                      "Content order should include text segment")
        XCTAssertTrue(assistantMsg.contentOrder.contains(.surface(0)),
                      "Content order should include surface reference")
    }

    // MARK: - Surface message preservation (for re-opening workspace)

    func testInlineSurfacePreservesSurfaceRef() {
        viewModel.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "App ready:")
        ))

        let showMsg = makeDynamicPageSurfaceMessage(
            surfaceId: "surface-msg-test",
            preview: ["title": "Reopenable App"]
        )
        viewModel.handleServerMessage(.uiSurfaceShow(showMsg))

        let surface = viewModel.messages[0].inlineSurfaces[0]
        XCTAssertNotNil(surface.surfaceRef,
                        "Inline surface should preserve a lightweight SurfaceRef for re-opening workspace")
        XCTAssertEqual(surface.surfaceRef?.surfaceId, "surface-msg-test")
        XCTAssertEqual(surface.surfaceRef?.sessionId, "sess-dp")
    }
}
