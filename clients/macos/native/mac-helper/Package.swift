// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MacHelper",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .executable(name: "vellum-mac-helper", targets: ["MacHelperExecutable"]),
    ],
    targets: [
        .target(name: "MacHelperCore"),
        .executableTarget(
            name: "MacHelperExecutable",
            dependencies: ["MacHelperCore"],
            exclude: ["Info.plist"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("Carbon"),
                .linkedFramework("IOKit"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("Speech"),
            ]
        ),
        .testTarget(
            name: "MacHelperCoreTests",
            dependencies: ["MacHelperCore"]
        ),
    ]
)
