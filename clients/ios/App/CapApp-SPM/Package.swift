// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v17)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.3.4"),
        .package(name: "CapacitorCommunityCameraPreview", path: "../../../../node_modules/.bun/@capacitor-community+camera-preview@8.0.1+33da1c2fb16abc29/node_modules/@capacitor-community/camera-preview"),
        .package(name: "CapacitorApp", path: "../../../../node_modules/.bun/@capacitor+app@8.1.0+33da1c2fb16abc29/node_modules/@capacitor/app"),
        .package(name: "CapacitorBrowser", path: "../../../../node_modules/.bun/@capacitor+browser@8.0.3+33da1c2fb16abc29/node_modules/@capacitor/browser"),
        .package(name: "CapacitorFileViewer", path: "../../../../node_modules/.bun/@capacitor+file-viewer@2.0.1+33da1c2fb16abc29/node_modules/@capacitor/file-viewer"),
        .package(name: "CapacitorFilesystem", path: "../../../../node_modules/.bun/@capacitor+filesystem@8.1.2+33da1c2fb16abc29/node_modules/@capacitor/filesystem"),
        .package(name: "CapacitorHaptics", path: "../../../../node_modules/.bun/@capacitor+haptics@8.0.0+33da1c2fb16abc29/node_modules/@capacitor/haptics"),
        .package(name: "CapacitorKeyboard", path: "../../../../node_modules/.bun/@capacitor+keyboard@8.0.5+33da1c2fb16abc29/node_modules/@capacitor/keyboard"),
        .package(name: "CapacitorLocalNotifications", path: "../../../../node_modules/.bun/@capacitor+local-notifications@8.2.0+33da1c2fb16abc29/node_modules/@capacitor/local-notifications"),
        .package(name: "CapacitorNetwork", path: "../../../../node_modules/.bun/@capacitor+network@8.0.0+33da1c2fb16abc29/node_modules/@capacitor/network"),
        .package(name: "CapacitorPushNotifications", path: "../../../../node_modules/.bun/@capacitor+push-notifications@8.0.3+33da1c2fb16abc29/node_modules/@capacitor/push-notifications"),
        .package(name: "CapacitorShare", path: "../../../../node_modules/.bun/@capacitor+share@8.0.1+33da1c2fb16abc29/node_modules/@capacitor/share"),
        .package(name: "CapawesomeCapacitorFilePicker", path: "../../../../node_modules/.bun/@capawesome+capacitor-file-picker@8.0.4+33da1c2fb16abc29/node_modules/@capawesome/capacitor-file-picker"),
        .package(name: "SentryCapacitor", path: "../../../../node_modules/.bun/@sentry+capacitor@4.1.0+1184c339b098859f/node_modules/@sentry/capacitor"),
        .package(name: "CapacitorPluginSafeArea", path: "../../../../node_modules/.bun/capacitor-plugin-safe-area@5.0.0+33da1c2fb16abc29/node_modules/capacitor-plugin-safe-area")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorCommunityCameraPreview", package: "CapacitorCommunityCameraPreview"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorBrowser", package: "CapacitorBrowser"),
                .product(name: "CapacitorFileViewer", package: "CapacitorFileViewer"),
                .product(name: "CapacitorFilesystem", package: "CapacitorFilesystem"),
                .product(name: "CapacitorHaptics", package: "CapacitorHaptics"),
                .product(name: "CapacitorKeyboard", package: "CapacitorKeyboard"),
                .product(name: "CapacitorLocalNotifications", package: "CapacitorLocalNotifications"),
                .product(name: "CapacitorNetwork", package: "CapacitorNetwork"),
                .product(name: "CapacitorPushNotifications", package: "CapacitorPushNotifications"),
                .product(name: "CapacitorShare", package: "CapacitorShare"),
                .product(name: "CapawesomeCapacitorFilePicker", package: "CapawesomeCapacitorFilePicker"),
                .product(name: "SentryCapacitor", package: "SentryCapacitor"),
                .product(name: "CapacitorPluginSafeArea", package: "CapacitorPluginSafeArea")
            ]
        )
    ]
)
