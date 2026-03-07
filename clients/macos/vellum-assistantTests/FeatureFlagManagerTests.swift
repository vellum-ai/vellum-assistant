import XCTest
@testable import VellumAssistantShared

final class MacOSClientFeatureFlagManagerTests: XCTestCase {

    /// Tests that a flag set to "true" is enabled.
    func testFlagSetToTrue() {
        // GIVEN an environment with a flag set to "true"
        let env = ["VELLUM_FLAG_MY_FEATURE": "true"]

        // WHEN we create a manager from that environment
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // THEN the flag is enabled
        XCTAssertTrue(manager.isEnabled("my_feature"))
    }

    /// Tests that a flag set to "1" is enabled.
    func testFlagSetToOne() {
        // GIVEN an environment with a flag set to "1"
        let env = ["VELLUM_FLAG_DARK_MODE": "1"]

        // WHEN we create a manager from that environment
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // THEN the flag is enabled
        XCTAssertTrue(manager.isEnabled("dark_mode"))
    }

    /// Tests that a flag set to "yes" is enabled.
    func testFlagSetToYes() {
        // GIVEN an environment with a flag set to "yes"
        let env = ["VELLUM_FLAG_BETA": "yes"]

        // WHEN we create a manager from that environment
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // THEN the flag is enabled
        XCTAssertTrue(manager.isEnabled("beta"))
    }

    /// Tests that a flag set to "on" is enabled.
    func testFlagSetToOn() {
        // GIVEN an environment with a flag set to "on"
        let env = ["VELLUM_FLAG_VERBOSE": "on"]

        // WHEN we create a manager from that environment
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // THEN the flag is enabled
        XCTAssertTrue(manager.isEnabled("verbose"))
    }

    /// Tests that a flag set to "false" is disabled.
    func testFlagSetToFalse() {
        // GIVEN an environment with a flag set to "false"
        let env = ["VELLUM_FLAG_DISABLED": "false"]

        // WHEN we create a manager from that environment
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // THEN the flag is disabled
        XCTAssertFalse(manager.isEnabled("disabled"))
    }

    /// Tests that a flag set to "0" is disabled.
    func testFlagSetToZero() {
        // GIVEN an environment with a flag set to "0"
        let env = ["VELLUM_FLAG_OFF": "0"]

        // WHEN we create a manager from that environment
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // THEN the flag is disabled
        XCTAssertFalse(manager.isEnabled("off"))
    }

    /// Tests that querying a flag that doesn't exist returns false.
    func testMissingFlagReturnsFalse() {
        // GIVEN an empty environment
        let env: [String: String] = [:]

        // WHEN we create a manager and query a nonexistent flag
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // THEN the flag is disabled
        XCTAssertFalse(manager.isEnabled("nonexistent"))
    }

    /// Tests that flag name lookup is case-insensitive.
    func testFlagLookupIsCaseInsensitive() {
        // GIVEN an environment with an uppercase flag name
        let env = ["VELLUM_FLAG_MY_FEATURE": "true"]

        // WHEN we create a manager from that environment
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // THEN the flag is found regardless of query casing
        XCTAssertTrue(manager.isEnabled("MY_FEATURE"))

        // AND mixed case also works
        XCTAssertTrue(manager.isEnabled("My_Feature"))
    }

    /// Tests that non-VELLUM_FLAG_ env vars are ignored.
    func testNonFlagEnvVarsAreIgnored() {
        // GIVEN an environment with unrelated variables
        let env = [
            "HOME": "/Users/test",
            "PATH": "/usr/bin",
            "VELLUM_FLAG_REAL": "true"
        ]

        // WHEN we create a manager from that environment
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // THEN only the VELLUM_FLAG_ variable is loaded
        XCTAssertTrue(manager.isEnabled("real"))

        // AND non-flag env vars are not treated as flags
        XCTAssertFalse(manager.isEnabled("HOME"))
        XCTAssertFalse(manager.isEnabled("PATH"))
    }

    /// Tests that multiple flags can be loaded simultaneously.
    func testMultipleFlags() {
        // GIVEN an environment with multiple flags
        let env = [
            "VELLUM_FLAG_ALPHA": "true",
            "VELLUM_FLAG_BETA": "false",
            "VELLUM_FLAG_GAMMA": "1"
        ]

        // WHEN we create a manager from that environment
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // THEN each flag has its correct value
        XCTAssertTrue(manager.isEnabled("alpha"))
        XCTAssertFalse(manager.isEnabled("beta"))
        XCTAssertTrue(manager.isEnabled("gamma"))

        // AND all three flags are loaded (verified individually above)
    }

    /// Tests that setOverride can enable a flag that was not in the environment.
    func testSetOverrideAddsFlag() {
        // GIVEN a manager with no flags
        let manager = MacOSClientFeatureFlagManager(environment: [:])

        // WHEN we set an override
        manager.setOverride("new_flag", enabled: true)

        // THEN the flag is enabled
        XCTAssertTrue(manager.isEnabled("new_flag"))
    }

    /// Tests that setOverride can change an existing flag's value.
    func testSetOverrideChangesExistingFlag() {
        // GIVEN a manager with a disabled flag
        let env = ["VELLUM_FLAG_FEATURE": "false"]
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // WHEN we override it to enabled
        manager.setOverride("feature", enabled: true)

        // THEN the flag is now enabled
        XCTAssertTrue(manager.isEnabled("feature"))
    }

    /// Tests that removeOverride removes a flag, making it return false.
    func testRemoveOverride() {
        // GIVEN a manager with a flag enabled
        let env = ["VELLUM_FLAG_TEMP": "true"]
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // WHEN we remove the override
        manager.removeOverride("temp")

        // THEN the flag returns false
        XCTAssertFalse(manager.isEnabled("temp"))
    }

    /// Tests that a flag with only the prefix and no name is ignored.
    func testEmptyFlagNameIsIgnored() {
        // GIVEN an environment where the key is exactly the prefix with no suffix
        let env = ["VELLUM_FLAG_": "true"]

        // WHEN we create a manager from that environment
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // THEN no flags are loaded — the empty-name key is not accessible
        XCTAssertFalse(manager.isEnabled(""))
    }

    /// Tests that whitespace in the flag value is trimmed during parsing.
    func testWhitespaceInValueIsTrimmed() {
        // GIVEN an environment with whitespace-padded values
        let env = ["VELLUM_FLAG_PADDED": "  true  "]

        // WHEN we create a manager from that environment
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // THEN the flag is correctly parsed as enabled
        XCTAssertTrue(manager.isEnabled("padded"))
    }

    /// Tests that env var keys are normalized by lowercasing and removing underscores.
    func testEnvKeyNormalizationRemovesUnderscores() {
        // GIVEN an environment with an underscore-separated flag name
        let env = ["VELLUM_FLAG_DARK_MODE": "1"]

        // WHEN we create a manager from that environment
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // THEN the flag is accessible via the camelCase string directly
        XCTAssertTrue(manager.isEnabled("darkMode"))

        // AND via the underscore-separated string (normalization strips underscores)
        XCTAssertTrue(manager.isEnabled("dark_mode"))
    }

    /// Tests that flag lookup is case-insensitive after normalization.
    func testNormalizationIsCaseInsensitive() {
        // GIVEN an environment with a mixed-case flag name
        let env = ["VELLUM_FLAG_DARK_MODE": "true"]

        // WHEN we create a manager from that environment
        let manager = MacOSClientFeatureFlagManager(environment: env)

        // THEN various casings all resolve to the same flag
        XCTAssertTrue(manager.isEnabled("DARK_MODE"))
        XCTAssertTrue(manager.isEnabled("Dark_Mode"))
        XCTAssertTrue(manager.isEnabled("darkmode"))
        XCTAssertTrue(manager.isEnabled("DarkMode"))
        XCTAssertTrue(manager.isEnabled("DARKMODE"))
    }

}
