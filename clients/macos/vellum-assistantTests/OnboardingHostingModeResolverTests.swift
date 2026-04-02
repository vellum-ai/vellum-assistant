import XCTest
@testable import VellumAssistantLib

final class OnboardingHostingModeResolverTests: XCTestCase {

    func testAvailableHostingModesUsesOldLocalFallbackWhenLocalDockerEnabled() {
        let modes = OnboardingHostingModeResolver.availableHostingModes(
            userHostedEnabled: false,
            localDockerEnabled: true
        )

        XCTAssertEqual(modes, [.vellumCloud, .local, .oldLocal])
    }

    func testAvailableHostingModesAddsUserHostedOptionsWithoutDockerCard() {
        let modes = OnboardingHostingModeResolver.availableHostingModes(
            userHostedEnabled: true,
            localDockerEnabled: false
        )

        XCTAssertEqual(modes, [.vellumCloud, .local, .aws, .gcp, .customHardware])
        XCTAssertFalse(modes.contains(.docker))
    }

    func testLocalSubtitleUsesDockerCopyWhenEnabled() {
        XCTAssertEqual(
            OnboardingHostingModeResolver.subtitle(
                for: .local,
                localDockerEnabled: true
            ),
            OnboardingState.HostingMode.docker.subtitle
        )
    }

    func testCloudProviderMapsLocalToDockerWhenEnabled() {
        XCTAssertEqual(
            OnboardingHostingModeResolver.cloudProvider(
                for: .local,
                localDockerEnabled: true
            ),
            OnboardingState.HostingMode.docker.rawValue
        )
    }

    func testCloudProviderMapsOldLocalBackToLegacyLocal() {
        XCTAssertEqual(
            OnboardingHostingModeResolver.cloudProvider(
                for: .oldLocal,
                localDockerEnabled: true
            ),
            OnboardingState.HostingMode.local.rawValue
        )
    }
}
