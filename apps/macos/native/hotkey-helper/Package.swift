// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "HotkeyHelper",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .executable(name: "hotkey-helper", targets: ["HotkeyHelperExecutable"]),
    ],
    targets: [
        .target(name: "HotkeyHelperCore"),
        .executableTarget(
            name: "HotkeyHelperExecutable",
            dependencies: ["HotkeyHelperCore"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("Carbon"),
            ]
        ),
        .testTarget(
            name: "HotkeyHelperCoreTests",
            dependencies: ["HotkeyHelperCore"]
        ),
    ]
)
