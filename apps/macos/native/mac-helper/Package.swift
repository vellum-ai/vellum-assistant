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
                .linkedFramework("Carbon"),
                .linkedFramework("IOKit"),
                .linkedFramework("Speech"),
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/MacHelperExecutable/Info.plist",
                ]),
            ]
        ),
        .testTarget(
            name: "MacHelperCoreTests",
            dependencies: ["MacHelperCore"]
        ),
    ]
)
