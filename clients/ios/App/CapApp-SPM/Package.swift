// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.3.4"),
        .package(name: "CapacitorApp", path: "../../../web/node_modules/@capacitor/app"),
        .package(name: "CapacitorBrowser", path: "../../../web/node_modules/@capacitor/browser"),
        .package(name: "CapacitorFilesystem", path: "../../../web/node_modules/@capacitor/filesystem"),
        .package(name: "CapacitorHaptics", path: "../../../web/node_modules/@capacitor/haptics"),
        .package(name: "CapacitorLocalNotifications", path: "../../../web/node_modules/@capacitor/local-notifications"),
        .package(name: "CapacitorNetwork", path: "../../../web/node_modules/@capacitor/network"),
        .package(name: "CapacitorPushNotifications", path: "../../../web/node_modules/@capacitor/push-notifications"),
        .package(name: "CapacitorShare", path: "../../../web/node_modules/@capacitor/share"),
        .package(name: "SentryCapacitor", path: "../../../web/node_modules/@sentry/capacitor"),
        .package(name: "CapacitorPluginSafeArea", path: "../../../web/node_modules/capacitor-plugin-safe-area")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorBrowser", package: "CapacitorBrowser"),
                .product(name: "CapacitorFilesystem", package: "CapacitorFilesystem"),
                .product(name: "CapacitorHaptics", package: "CapacitorHaptics"),
                .product(name: "CapacitorLocalNotifications", package: "CapacitorLocalNotifications"),
                .product(name: "CapacitorNetwork", package: "CapacitorNetwork"),
                .product(name: "CapacitorPushNotifications", package: "CapacitorPushNotifications"),
                .product(name: "CapacitorShare", package: "CapacitorShare"),
                .product(name: "SentryCapacitor", package: "SentryCapacitor"),
                .product(name: "CapacitorPluginSafeArea", package: "CapacitorPluginSafeArea")
            ]
        )
    ]
)
