import ApplicationServices

public enum ChromiumAccessibility {
    /// Electron supports the manual flag; Chrome uses the enhanced UI flag.
    @discardableResult
    public static func enable(setAttribute: (String) -> AXError) -> AXError {
        let manual = setAttribute("AXManualAccessibility")
        guard manual != .success else { return manual }
        return setAttribute("AXEnhancedUserInterface")
    }
}
