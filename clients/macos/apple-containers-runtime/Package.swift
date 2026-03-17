// swift-tools-version: 5.9
import PackageDescription

// AppleContainersRuntime — optional nested package owning the macOS 15+
// Apple Containerization dependency.  This package is intentionally separate
// from the main clients/Package.swift so that the main app target can stay on
// macOS 14.  Build scripts detect whether the active toolchain can compile this
// package and only embed the resulting module when it can.
let package = Package(
    name: "AppleContainersRuntime",
    platforms: [
        .macOS("15.0")
    ],
    products: [
        .library(
            name: "AppleContainersRuntime",
            type: .dynamic,
            targets: ["AppleContainersRuntime"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/apple/containerization.git", exact: "0.28.0")
    ],
    targets: [
        .target(
            name: "AppleContainersRuntime",
            dependencies: [
                .product(name: "Containerization", package: "containerization"),
                .product(name: "ContainerizationArchive", package: "containerization"),
                .product(name: "ContainerizationOCI", package: "containerization"),
            ],
            path: "Sources/AppleContainersRuntime",
            swiftSettings: [
                .define("DEBUG", .when(configuration: .debug))
            ]
        )
    ]
)
