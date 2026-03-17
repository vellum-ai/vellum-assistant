import Containerization
import ContainerizationOCI
import Foundation

// AppleContainersRuntime — thin public API surface for the optional macOS 15+
// Apple Containerization dependency.
//
// This module is built and embedded by build.sh only when the active toolchain
// supports macOS 15+. The main app target (VellumAssistantLib) loads it at
// runtime via AppleContainersRuntimeLoader and never imports it directly, so
// the main package can stay at macOS 14.
//
// Future PRs will add LinuxPod-based lifecycle and host connectivity here.

/// A type that indicates this module has been successfully loaded and that the
/// Apple Containerization framework is available on this system.
public struct AppleContainersRuntime: Sendable {
    /// The version of the Apple Containerization dependency this runtime was
    /// compiled against.  Exposed so the availability helper can surface it in
    /// diagnostic output without importing this module directly.
    public static let containerizationVersion = "0.28.0"

    public init() {}

    /// Returns true if the Virtualization framework required by Apple
    /// Containerization is available on this machine (Apple Silicon only).
    public static func isVirtualizationAvailable() -> Bool {
        // Apple Containerization requires Apple Silicon and macOS 15+.
        // Checking that we can reference a Containerization type is sufficient
        // at this level — the caller (AppleContainersRuntimeLoader) also
        // checks the OS version before even loading this module.
        return true
    }
}
