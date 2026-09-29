import Foundation

/// Which windows a capture scoped to a display leaves out.
///
/// A shared display shows the user's whole screen, the Vellum app included:
/// the assistant is asked about what the user sees, and the app is part of
/// that. What stays out is the assistant's own furniture: every window of
/// this helper, and the app's windows above the ordinary window layer (the
/// companion, its call bar and popover, the frame around the share, the
/// dictation overlay), all of which float.
public enum DisplayCaptureExclusion {
    /// The window server's layer for ordinary application windows.
    public static let normalWindowLayer = 0

    public static func excludes(ownerPID: pid_t, layer: Int, helperPID: pid_t, hostPID: pid_t) -> Bool {
        if ownerPID == helperPID {
            return true
        }
        return ownerPID == hostPID && layer != normalWindowLayer
    }
}
