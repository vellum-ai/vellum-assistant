import Foundation

enum SharedUserDefaults {
    static var standard: UserDefaults {
        #if SWIFT_PACKAGE
        return packageDefaults
        #else
        return .standard
        #endif
    }

    #if SWIFT_PACKAGE
    private static let packageDefaults: UserDefaults = {
        UserDefaults(suiteName: "com.vellum.vellum-assistant.swiftpackage") ?? UserDefaults()
    }()
    #endif
}
