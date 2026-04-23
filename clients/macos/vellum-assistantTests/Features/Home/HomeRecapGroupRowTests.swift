import SwiftUI
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Smoke tests for ``HomeRecapGroupRow``.
///
/// These tests guard the two things that reliably regress when this view
/// is touched: (1) the stored `children` list round-trips unchanged
/// through `init`, and (2) both the collapsed and expanded body
/// branches type-check and build without crashing. Visual fidelity is
/// covered by the Component Gallery; this file exists so a rename or
/// API drift breaks CI.
final class HomeRecapGroupRowTests: XCTestCase {

    private func makeChildren() -> [HomeRecapGroupRow.Child] {
        [
            HomeRecapGroupRow.Child(
                id: "a",
                icon: .bell,
                iconForeground: VColor.feedDigestStrong,
                iconBackground: VColor.feedDigestWeak,
                title: "First"
            ),
            HomeRecapGroupRow.Child(
                id: "b",
                icon: .bell,
                iconForeground: VColor.feedDigestStrong,
                iconBackground: VColor.feedDigestWeak,
                title: "Second"
            ),
            HomeRecapGroupRow.Child(
                id: "c",
                icon: .bell,
                iconForeground: VColor.feedDigestStrong,
                iconBackground: VColor.feedDigestWeak,
                title: "Third"
            ),
        ]
    }

    private func makeView(
        isExpanded: Binding<Bool>,
        children: [HomeRecapGroupRow.Child]
    ) -> HomeRecapGroupRow {
        HomeRecapGroupRow(
            parentIcon: .bell,
            parentIconForeground: VColor.feedDigestStrong,
            parentIconBackground: VColor.feedDigestWeak,
            parentTitle: "Parent",
            children: children,
            isExpanded: isExpanded,
            onParentTap: {},
            onChildTap: { _ in }
        )
    }

    func test_init_storesChildren() {
        let children = makeChildren()
        let view = makeView(isExpanded: .constant(false), children: children)

        XCTAssertEqual(view.children.count, children.count)
        XCTAssertEqual(view.children.map(\.id), ["a", "b", "c"])
        XCTAssertEqual(view.children.map(\.title), ["First", "Second", "Third"])
    }

    func test_collapsedAndExpanded_bothBuildBodyWithoutCrash() {
        let children = makeChildren()

        let collapsed = makeView(isExpanded: .constant(false), children: children)
        _ = collapsed.body

        let expanded = makeView(isExpanded: .constant(true), children: children)
        _ = expanded.body
    }
}
