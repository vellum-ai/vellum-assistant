import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class MessageInspectorPayloadModelTests: XCTestCase {
    func testPayloadDefaultsToTreeWhenSourceIsValidJSON() {
        let model = MessageInspectorPayloadModel(
            payload: AnyCodable(["beta": 2, "alpha": 1])
        )

        XCTAssertEqual(model.availableViewModes, [.tree, .source])
        XCTAssertEqual(model.viewMode, .tree)
        XCTAssertTrue(model.showsViewModePicker)
        XCTAssertTrue(model.showsExpandCollapseActions)
        XCTAssertEqual(
            model.source,
            """
            {
              "alpha" : 1,
              "beta" : 2
            }
            """
        )
    }

    func testPreferredSourceModeKeepsTreeAvailableButHidesTreeActions() {
        let model = MessageInspectorPayloadModel(
            payload: AnyCodable(["ok": true]),
            preferredViewMode: .source
        )

        XCTAssertEqual(model.availableViewModes, [.tree, .source])
        XCTAssertEqual(model.viewMode, .source)
        XCTAssertFalse(model.showsExpandCollapseActions)
    }

    func testInvalidSourceFallsBackToSourceMode() {
        let model = MessageInspectorPayloadModel(
            source: "not valid json",
            preferredViewMode: .tree
        )

        XCTAssertEqual(model.availableViewModes, [.source])
        XCTAssertEqual(model.viewMode, .source)
        XCTAssertFalse(model.showsViewModePicker)
        XCTAssertFalse(model.showsExpandCollapseActions)
        XCTAssertFalse(model.isTreeAvailable)
    }

    func testTopLevelStringPayloadPreservesRawSourceVerbatim() {
        let rawSource = "{\"answer\": \"hello \\\"world\\\"\"}"
        let model = MessageInspectorPayloadModel(payload: AnyCodable(rawSource))

        XCTAssertEqual(model.availableViewModes, [.source])
        XCTAssertEqual(model.viewMode, .source)
        XCTAssertEqual(model.source, rawSource)
        XCTAssertFalse(model.showsViewModePicker)
        XCTAssertFalse(model.showsExpandCollapseActions)
        XCTAssertFalse(model.isTreeAvailable)
    }

    func testTopLevelStringPayloadIgnoresPreferredTreeMode() {
        let model = MessageInspectorPayloadModel(
            payload: AnyCodable("hello"),
            preferredViewMode: .tree
        )

        XCTAssertEqual(model.availableViewModes, [.source])
        XCTAssertEqual(model.viewMode, .source)
        XCTAssertEqual(model.source, "hello")
    }
}
