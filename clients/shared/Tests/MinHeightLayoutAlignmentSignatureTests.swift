import Foundation
import XCTest

final class MinHeightLayoutAlignmentSignatureTests: XCTestCase {
    func testMinHeightExplicitAlignmentOverridesUseLayoutCacheType() throws {
        let layoutFiles = [
            "BottomAlignedMinHeightLayout.swift",
            "CenterAlignedMinHeightLayout.swift",
            "TopAlignedMinHeightLayout.swift",
        ]
        let modifiersDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("DesignSystem/Modifiers")

        for fileName in layoutFiles {
            let sourceURL = modifiersDirectory.appendingPathComponent(fileName)
            let source = try String(contentsOf: sourceURL, encoding: .utf8)
            let explicitAlignmentLines = source
                .split(separator: "\n")
                .filter { $0.contains("explicitAlignment(of guide:") }

            XCTAssertEqual(explicitAlignmentLines.count, 2, "\(fileName) should override both explicitAlignment variants")

            for line in explicitAlignmentLines {
                XCTAssertTrue(
                    line.contains("cache: inout SingleSubviewLayoutCache"),
                    "\(fileName) explicitAlignment overload must use the layout cache type"
                )
                XCTAssertFalse(
                    line.contains("cache: inout ()"),
                    "\(fileName) explicitAlignment overload no longer matches Layout.Cache"
                )
            }
        }
    }
}
