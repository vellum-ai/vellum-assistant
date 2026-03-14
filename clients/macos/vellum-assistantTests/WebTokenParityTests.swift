import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class WebTokenParityTests: XCTestCase {

    /// Verifies that the injected CSS token block contains the correct semantic
    /// hex values for every canonical token in both light and dark modes.
    func testInjectedCSSContainsAllSemanticLightValues() {
        let css = WebTokenInjector.cssTokenBlock()

        let expectedLightValues: [(String, String)] = [
            ("--v-primary-disabled", "#D4D1C1"),
            ("--v-primary-base", "#516748"),
            ("--v-primary-hover", "#657D5B"),
            ("--v-primary-active", "#7A8B6F"),
            ("--v-surface-base", "#E8E6DA"),
            ("--v-surface-overlay", "#F5F3EB"),
            ("--v-surface-active", "#D4D1C1"),
            ("--v-surface-lift", "#FFFFFF"),
            ("--v-border-disabled", "#D4D1C1"),
            ("--v-border-base", "#BDB9A9"),
            ("--v-border-hover", "#A1A096"),
            ("--v-border-active", "#7A8B6F"),
            ("--v-content-emphasized", "#20201E"),
            ("--v-content-default", "#2A2A28"),
            ("--v-content-secondary", "#4A4A46"),
            ("--v-content-tertiary", "#A1A096"),
            ("--v-content-disabled", "#BDB9A9"),
            ("--v-content-background", "#D4D1C1"),
            ("--v-content-inset", "#FFFFFF"),
            ("--v-system-positive-strong", "#516748"),
            ("--v-system-positive-weak", "#D4DFD0"),
            ("--v-system-negative-strong", "#DA491A"),
            ("--v-system-negative-hover", "#E86B40"),
            ("--v-system-negative-weak", "#F7DAC9"),
            ("--v-system-mid-strong", "#F1B21E"),
            ("--v-system-mid-weak", "#FCF3DD"),
            ("--v-aux-white", "#FFFFFF"),
        ]

        for (varName, hex) in expectedLightValues {
            XCTAssertTrue(
                css.contains("\(varName): \(hex)"),
                "Missing or incorrect light value for \(varName): expected \(hex)"
            )
        }
    }

    func testInjectedCSSContainsAllSemanticDarkValues() {
        let css = WebTokenInjector.cssTokenBlock()

        let expectedDarkValues: [(String, String)] = [
            ("--v-primary-disabled", "#3A3A37"),
            ("--v-primary-base", "#657D5B"),
            ("--v-primary-hover", "#516748"),
            ("--v-primary-active", "#7A8B6F"),
            ("--v-surface-base", "#2A2A28"),
            ("--v-surface-overlay", "#20201E"),
            ("--v-surface-active", "#3A3A37"),
            ("--v-surface-lift", "#000000"),
            ("--v-border-disabled", "#3A3A37"),
            ("--v-border-base", "#4A4A46"),
            ("--v-border-hover", "#6B6B65"),
            ("--v-border-active", "#7A8B6F"),
            ("--v-content-emphasized", "#F5F3EB"),
            ("--v-content-default", "#E8E6DA"),
            ("--v-content-secondary", "#BDB9A9"),
            ("--v-content-tertiary", "#A1A096"),
            ("--v-content-disabled", "#6B6B65"),
            ("--v-content-background", "#3A3A37"),
            ("--v-content-inset", "#000000"),
            ("--v-system-positive-strong", "#516748"),
            ("--v-system-positive-weak", "#1A2316"),
            ("--v-system-negative-strong", "#DA491A"),
            ("--v-system-negative-hover", "#AB3F1C"),
            ("--v-system-negative-weak", "#4E281D"),
            ("--v-system-mid-strong", "#F1B21E"),
            ("--v-system-mid-weak", "#4B3D1E"),
            ("--v-aux-white", "#FFFFFF"),
        ]

        // The dark values appear inside the @media block; just check they exist
        // at least once in the CSS (the light block won't have these values for
        // tokens that differ between modes).
        for (varName, hex) in expectedDarkValues {
            let needle = "\(varName): \(hex)"
            XCTAssertTrue(
                css.contains(needle),
                "Missing or incorrect dark value for \(varName): expected \(hex)"
            )
        }
    }

    func testCSSDoesNotContainLegacyVariableNames() {
        let css = WebTokenInjector.cssTokenBlock()

        let legacyPatterns = ["--v-bg:", "--v-text:", "--v-accent:", "--v-surface:"]
        for pattern in legacyPatterns {
            XCTAssertFalse(
                css.contains(pattern),
                "CSS still contains legacy variable pattern: \(pattern)"
            )
        }
    }

    func testCSSDoesNotContainDangerNaming() {
        let css = WebTokenInjector.cssTokenBlock()
        XCTAssertFalse(
            css.contains("danger"),
            "CSS still contains 'danger' naming — should be 'negative'"
        )
    }
}
