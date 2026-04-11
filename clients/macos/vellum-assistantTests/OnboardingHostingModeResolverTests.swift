import XCTest
@testable import VellumAssistantLib

final class OnboardingHostingModeResolverTests: XCTestCase {

    // MARK: - Available Hosting Modes

    func testAvailableHostingModesUsesOldLocalFallbackWhenLocalDockerEnabled() {
        let modes = OnboardingHostingModeResolver.availableHostingModes(
            userHostedEnabled: false,
            localDockerEnabled: true,
            appleContainerEnabled: false
        )

        XCTAssertEqual(modes, [.vellumCloud, .oldLocal, .local])
    }

    func testAvailableHostingModesAddsUserHostedOptionsWithoutDockerCard() {
        let modes = OnboardingHostingModeResolver.availableHostingModes(
            userHostedEnabled: true,
            localDockerEnabled: false,
            appleContainerEnabled: false
        )

        XCTAssertEqual(modes, [.vellumCloud, .local, .aws, .gcp, .customHardware])
        XCTAssertFalse(modes.contains(.docker))
    }

    func testAvailableHostingModesShowsDockerAndHostLocalWhenAppleContainerEnabled() {
        let modes = OnboardingHostingModeResolver.availableHostingModes(
            userHostedEnabled: false,
            localDockerEnabled: false,
            appleContainerEnabled: true
        )

        XCTAssertEqual(modes, [.vellumCloud, .local, .docker, .oldLocal])
    }

    func testAppleContainerTakesPrecedenceOverLocalDocker() {
        let modes = OnboardingHostingModeResolver.availableHostingModes(
            userHostedEnabled: false,
            localDockerEnabled: true,
            appleContainerEnabled: true
        )

        XCTAssertEqual(modes, [.vellumCloud, .local, .docker, .oldLocal])
    }

    // MARK: - Display Names

    func testDisplayNameShowsDockerLocalWhenAppleContainerEnabled() {
        XCTAssertEqual(
            OnboardingHostingModeResolver.displayName(for: .docker, localDockerEnabled: false, appleContainerEnabled: true),
            "Docker Local"
        )
    }

    func testDisplayNameShowsHostLocalWhenAppleContainerEnabled() {
        XCTAssertEqual(
            OnboardingHostingModeResolver.displayName(for: .oldLocal, localDockerEnabled: false, appleContainerEnabled: true),
            "Host Local"
        )
    }

    func testDisplayNameUsesDefaultWhenAppleContainerDisabled() {
        XCTAssertEqual(
            OnboardingHostingModeResolver.displayName(for: .docker, localDockerEnabled: false, appleContainerEnabled: false),
            OnboardingState.HostingMode.docker.displayName
        )
    }

    func testDisplayNameShowsDockerExperimentalWhenLocalDockerEnabled() {
        XCTAssertEqual(
            OnboardingHostingModeResolver.displayName(for: .local, localDockerEnabled: true, appleContainerEnabled: false),
            "Docker (Experimental)"
        )
    }

    func testDisplayNameShowsLocalBareMetalWhenLocalDockerEnabled() {
        XCTAssertEqual(
            OnboardingHostingModeResolver.displayName(for: .oldLocal, localDockerEnabled: true, appleContainerEnabled: false),
            "Local (Bare Metal)"
        )
    }

    // MARK: - Subtitles

    func testLocalSubtitleUsesDockerCopyWhenEnabled() {
        XCTAssertEqual(
            OnboardingHostingModeResolver.subtitle(
                for: .local,
                localDockerEnabled: true,
                appleContainerEnabled: false
            ),
            "Runs locally in a Docker container for added isolation."
        )
    }

    func testOldLocalSubtitleUsesBareMetalCopyWhenDockerEnabled() {
        XCTAssertEqual(
            OnboardingHostingModeResolver.subtitle(
                for: .oldLocal,
                localDockerEnabled: true,
                appleContainerEnabled: false
            ),
            "Runs directly on your Mac. No containers, no extra setup."
        )
    }

    func testLocalSubtitleUsesAppleContainerCopyWhenEnabled() {
        XCTAssertEqual(
            OnboardingHostingModeResolver.subtitle(
                for: .local,
                localDockerEnabled: false,
                appleContainerEnabled: true
            ),
            "Native macOS sandbox. Your machine, your data, fully isolated."
        )
    }

    func testAppleContainerSubtitleTakesPrecedenceOverDocker() {
        XCTAssertEqual(
            OnboardingHostingModeResolver.subtitle(
                for: .local,
                localDockerEnabled: true,
                appleContainerEnabled: true
            ),
            "Native macOS sandbox. Your machine, your data, fully isolated."
        )
    }

    // MARK: - Cloud Provider

    func testCloudProviderMapsLocalToDockerWhenEnabled() {
        XCTAssertEqual(
            OnboardingHostingModeResolver.cloudProvider(
                for: .local,
                localDockerEnabled: true,
                appleContainerEnabled: false
            ),
            OnboardingState.HostingMode.docker.rawValue
        )
    }

    func testCloudProviderMapsOldLocalBackToLegacyLocal() {
        XCTAssertEqual(
            OnboardingHostingModeResolver.cloudProvider(
                for: .oldLocal,
                localDockerEnabled: true,
                appleContainerEnabled: false
            ),
            OnboardingState.HostingMode.local.rawValue
        )
    }

    func testCloudProviderMapsLocalToAppleContainerWhenEnabled() {
        XCTAssertEqual(
            OnboardingHostingModeResolver.cloudProvider(
                for: .local,
                localDockerEnabled: false,
                appleContainerEnabled: true
            ),
            "apple-container"
        )
    }

    func testCloudProviderAppleContainerTakesPrecedenceOverDocker() {
        XCTAssertEqual(
            OnboardingHostingModeResolver.cloudProvider(
                for: .local,
                localDockerEnabled: true,
                appleContainerEnabled: true
            ),
            "apple-container"
        )
    }
}
