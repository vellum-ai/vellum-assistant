import XCTest
@testable import VellumAssistantShared

final class ColorTokenParityTests: XCTestCase {

    /// Canonical Figma semantic color table — every token must resolve to these exact hex values.
    private static let expected: [(VSemanticColorToken, String, String)] = [
        (.primaryDisabled, "#D4D1C1", "#3A3A37"),
        (.primaryBase, "#516748", "#657D5B"),
        (.primaryHover, "#657D5B", "#516748"),
        (.primaryActive, "#7A8B6F", "#7A8B6F"),

        (.surfaceBase, "#E8E6DA", "#2A2A28"),
        (.surfaceOverlay, "#F5F3EB", "#20201E"),
        (.surfaceActive, "#D4D1C1", "#3A3A37"),
        (.surfaceLift, "#FFFFFF", "#000000"),

        (.borderDisabled, "#D4D1C1", "#3A3A37"),
        (.borderBase, "#BDB9A9", "#4A4A46"),
        (.borderHover, "#A1A096", "#6B6B65"),
        (.borderActive, "#7A8B6F", "#7A8B6F"),

        (.contentEmphasized, "#20201E", "#F5F3EB"),
        (.contentDefault, "#2A2A28", "#E8E6DA"),
        (.contentSecondary, "#4A4A46", "#BDB9A9"),
        (.contentTertiary, "#A1A096", "#A1A096"),
        (.contentDisabled, "#BDB9A9", "#6B6B65"),
        (.contentBackground, "#D4D1C1", "#3A3A37"),
        (.contentInset, "#FFFFFF", "#000000"),

        (.systemPositiveStrong, "#516748", "#516748"),
        (.systemPositiveWeak, "#D4DFD0", "#1A2316"),
        (.systemNegativeStrong, "#DA491A", "#DA491A"),
        (.systemNegativeHover, "#E86B40", "#AB3F1C"),
        (.systemNegativeWeak, "#F7DAC9", "#4E281D"),
        (.systemMidStrong, "#F1B21E", "#F1B21E"),
        (.systemMidWeak, "#FCF3DD", "#4B3D1E"),

        (.auxWhite, "#FFFFFF", "#FFFFFF"),
    ]

    func testAllSemanticTokensHaveExpectedHexPairs() {
        for (token, expectedLight, expectedDark) in Self.expected {
            let pair = VColor.pair(for: token)
            XCTAssertEqual(
                pair.lightHex.uppercased(), expectedLight.uppercased(),
                "\(token.rawValue) light mismatch"
            )
            XCTAssertEqual(
                pair.darkHex.uppercased(), expectedDark.uppercased(),
                "\(token.rawValue) dark mismatch"
            )
        }
    }

    func testSemanticPairsDictionaryCoversAllTokens() {
        for token in VSemanticColorToken.allCases {
            XCTAssertNotNil(
                VColor.semanticPairs[token],
                "Missing semanticPairs entry for \(token.rawValue)"
            )
        }
    }

    func testExpectedTableCoversAllTokens() {
        let expectedTokens = Set(Self.expected.map(\.0))
        for token in VSemanticColorToken.allCases {
            XCTAssertTrue(
                expectedTokens.contains(token),
                "Token \(token.rawValue) not covered by parity test table"
            )
        }
    }
}
