// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "ax-helper",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "ax-helper",
            path: "Sources",
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("AppKit"),
            ]
        ),
    ]
)
