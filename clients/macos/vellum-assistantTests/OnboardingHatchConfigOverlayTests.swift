import XCTest
@testable import VellumAssistantLib

final class OnboardingHatchConfigOverlayTests: XCTestCase {

    // MARK: - Managed-inference path (skippedAPIKeyEntry == true)

    func testManagedInferenceEmitsBalancedActiveProfile() {
        let overlay = onboardingHatchConfigOverlay(
            skippedAPIKeyEntry: true,
            selectedProvider: "anthropic",
            defaultProvider: "anthropic"
        )

        XCTAssertEqual(overlay, ["llm.activeProfile": "balanced"])
    }

    func testManagedInferenceIgnoresSelectedProvider() {
        // Even if the UI default provider differs, managed inference always
        // points at the daemon-seeded `balanced` profile (managed Anthropic).
        let overlay = onboardingHatchConfigOverlay(
            skippedAPIKeyEntry: true,
            selectedProvider: "openai",
            defaultProvider: "anthropic"
        )

        XCTAssertEqual(overlay, ["llm.activeProfile": "balanced"])
    }

    func testManagedInferenceDoesNotEmitDefaultProvider() {
        // Crucial invariant: no `llm.default.provider` so the seeder does NOT
        // materialize an `anthropic-personal` connection during hatch seeding.
        let overlay = onboardingHatchConfigOverlay(
            skippedAPIKeyEntry: true,
            selectedProvider: "anthropic",
            defaultProvider: "anthropic"
        )

        XCTAssertNil(overlay["llm.default.provider"])
    }

    // MARK: - BYOK path (skippedAPIKeyEntry == false)

    func testBYOKEmitsSelectedProviderAsDefault() {
        let overlay = onboardingHatchConfigOverlay(
            skippedAPIKeyEntry: false,
            selectedProvider: "openai",
            defaultProvider: "anthropic"
        )

        XCTAssertEqual(overlay, ["llm.default.provider": "openai"])
    }

    func testBYOKWithAnthropicProvider() {
        let overlay = onboardingHatchConfigOverlay(
            skippedAPIKeyEntry: false,
            selectedProvider: "anthropic",
            defaultProvider: "anthropic"
        )

        XCTAssertEqual(overlay, ["llm.default.provider": "anthropic"])
    }

    func testBYOKFallsBackToDefaultProviderWhenSelectedIsEmpty() {
        let overlay = onboardingHatchConfigOverlay(
            skippedAPIKeyEntry: false,
            selectedProvider: "",
            defaultProvider: "anthropic"
        )

        XCTAssertEqual(overlay, ["llm.default.provider": "anthropic"])
    }

    func testBYOKUsesInjectedDefaultProviderWhenSelectedIsEmpty() {
        // The fallback isn't hardcoded — it tracks whatever the registry says.
        let overlay = onboardingHatchConfigOverlay(
            skippedAPIKeyEntry: false,
            selectedProvider: "",
            defaultProvider: "openai"
        )

        XCTAssertEqual(overlay, ["llm.default.provider": "openai"])
    }

    func testBYOKDoesNotEmitActiveProfile() {
        // The BYOK path lets the daemon seeder pick the active profile based
        // on whether a user connection is materialized — emitting
        // `llm.activeProfile` here would short-circuit that resolution.
        let overlay = onboardingHatchConfigOverlay(
            skippedAPIKeyEntry: false,
            selectedProvider: "anthropic",
            defaultProvider: "anthropic"
        )

        XCTAssertNil(overlay["llm.activeProfile"])
    }
}
