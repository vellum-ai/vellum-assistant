import SwiftUI
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Smoke tests for ``HomeScheduledDetailPanel``.
///
/// These tests intentionally stay at the view-model / constructor level —
/// they verify that the value-type `DetailRow` payload round-trips and
/// that the optional secondary action doesn't crash the body builder.
final class HomeScheduledDetailPanelTests: XCTestCase {

    func test_init_storesRows() {
        let rows: [HomeScheduledDetailPanel.DetailRow] = [
            .init(key: "Name", value: "Morning check-in"),
            .init(key: "Mode", value: "notify"),
            .init(key: "Enabled", value: "true"),
        ]

        let view = HomeScheduledDetailPanel(
            title: "Scheduled Thing",
            description: "desc",
            rows: rows,
            primaryActionLabel: "Action",
            secondaryActionLabel: "Action",
            onClose: {},
            onPrimaryAction: {},
            onSecondaryAction: {}
        )

        XCTAssertEqual(view.rows.count, 3)
        XCTAssertEqual(view.rows.map(\.key), ["Name", "Mode", "Enabled"])
        XCTAssertEqual(view.rows.map(\.value), ["Morning check-in", "notify", "true"])
    }

    func test_secondaryActionOptional() {
        let rows: [HomeScheduledDetailPanel.DetailRow] = [
            .init(key: "Name", value: "Morning check-in"),
        ]

        let withoutSecondary = HomeScheduledDetailPanel(
            title: "Scheduled Thing",
            description: "desc",
            rows: rows,
            primaryActionLabel: "Action",
            secondaryActionLabel: nil,
            onClose: {},
            onPrimaryAction: {},
            onSecondaryAction: nil
        )
        _ = withoutSecondary.body

        let withSecondary = HomeScheduledDetailPanel(
            title: "Scheduled Thing",
            description: "desc",
            rows: rows,
            primaryActionLabel: "Action",
            secondaryActionLabel: "Action",
            onClose: {},
            onPrimaryAction: {},
            onSecondaryAction: {}
        )
        _ = withSecondary.body
    }
}
