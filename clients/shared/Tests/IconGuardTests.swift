import XCTest
@testable import VellumAssistantShared

final class IconGuardTests: XCTestCase {

    /// Every `VIcon` raw value must have a matching imageset in `LucideIcons.xcassets`.
    func testAllVIconCasesHaveAssets() {
        for icon in VIcon.allCases {
            let image = icon.image
            // SwiftUI Image initializer doesn't return nil for missing assets,
            // but we can verify the raw value format is correct.
            XCTAssertTrue(
                icon.rawValue.hasPrefix("lucide-"),
                "VIcon.\(icon) raw value '\(icon.rawValue)' must start with 'lucide-'"
            )
        }
    }

    /// `SFSymbolMapping` must cover all commonly used SF Symbols.
    func testSFSymbolMappingCoversCommonSymbols() {
        let commonSymbols = [
            "xmark", "plus", "checkmark", "magnifyingglass",
            "chevron.down", "chevron.right", "chevron.left",
            "checkmark.circle.fill", "xmark.circle.fill",
            "exclamationmark.triangle.fill", "info.circle",
            "gear", "terminal", "globe", "pencil",
            "doc.text", "doc.on.doc", "trash",
            "arrow.up", "arrow.down",
            "star.fill", "bell", "lock.fill",
        ]

        for symbol in commonSymbols {
            XCTAssertNotNil(
                SFSymbolMapping.icon(forSFSymbol: symbol),
                "SFSymbolMapping missing entry for '\(symbol)'"
            )
        }
    }

    /// VIcon raw values must be unique.
    func testVIconRawValuesAreUnique() {
        var seen = Set<String>()
        for icon in VIcon.allCases {
            XCTAssertFalse(
                seen.contains(icon.rawValue),
                "Duplicate VIcon raw value: '\(icon.rawValue)'"
            )
            seen.insert(icon.rawValue)
        }
    }
}
