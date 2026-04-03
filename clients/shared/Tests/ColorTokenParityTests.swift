import XCTest
@testable import VellumAssistantShared

final class ColorTokenParityTests: XCTestCase {

    /// Canonical Figma semantic color table — every token must resolve to these exact hex values.
    private static let expected: [(VSemanticColorToken, String, String)] = [
        (.primaryDisabled, "#F6F5F4", "#2D3339"),
        (.primaryBase, "#17191C", "#FDFDFC"),
        (.primaryHover, "#24292E", "#F2F0EE"),
        (.primaryActive, "#2D3339", "#E9E6E2"),
        (.primarySecondHover, "#B9B4AC", "#E9E6E2"),

        (.surfaceBase, "#F6F5F4", "#17191C"),
        (.surfaceOverlay, "#FDFDFC", "#1C2024"),
        (.surfaceActive, "#F2F0EE", "#444D56"),
        (.surfaceLift, "#FFFFFF", "#24292E"),
        (.surfaceHover, "#B9B4AC", "#E9E6E2"),

        (.borderDisabled, "#E9E6E2", "#1C2024"),
        (.borderBase, "#F2F0EE", "#24292E"),
        (.borderHover, "#F6F5F4", "#2D3339"),
        (.borderActive, "#2D3339", "#F6F5F4"),
        (.borderElement, "#D3CCC5", "#5A6672"),

        (.contentEmphasized, "#161616", "#FDFDFC"),
        (.contentDefault, "#24292E", "#F6F5F4"),
        (.contentSecondary, "#5A6672", "#A9B2BB"),
        (.contentTertiary, "#71808E", "#8D99A5"),
        (.contentDisabled, "#A9B2BB", "#5A6672"),
        (.contentBackground, "#F2F0EE", "#2D3339"),
        (.contentInset, "#FDFDFC", "#17191C"),

        (.systemPositiveStrong, "#277E41", "#277E41"),
        (.systemPositiveWeak, "#E9F2EC", "#1C251F"),
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
