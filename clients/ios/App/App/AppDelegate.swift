import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {}
    func applicationDidEnterBackground(_ application: UIApplication) {}
    func applicationWillEnterForeground(_ application: UIApplication) {}
    func applicationDidBecomeActive(_ application: UIApplication) {}
    func applicationWillTerminate(_ application: UIApplication) {}

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Universal Links — navigate the Capacitor webview to the incoming URL
        // so that deep links (e.g. ?app=X#/pr/...) open in-app instead of Safari.
        if userActivity.activityType == NSUserActivityTypeBrowsingWeb,
           let url = userActivity.webpageURL {
            navigateWebView(to: url)
        }
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    // MARK: - APNs Token Forwarding

    func application(
      _ application: UIApplication,
      didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
      NotificationCenter.default.post(
        name: .capacitorDidRegisterForRemoteNotifications,
        object: deviceToken
      )
    }

    func application(
      _ application: UIApplication,
      didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
      NotificationCenter.default.post(
        name: .capacitorDidFailToRegisterForRemoteNotifications,
        object: error
      )
    }

    // MARK: - Universal Link Navigation

    /// Find the Capacitor bridge's WKWebView and navigate it to the given URL.
    private func navigateWebView(to url: URL) {
        guard let rootVC = window?.rootViewController else { return }
        // The Capacitor bridge VC is typically the root or embedded in a nav controller.
        if let bridgeVC = rootVC as? CAPBridgeViewController {
            bridgeVC.webView?.load(URLRequest(url: url))
        } else if let nav = rootVC as? UINavigationController,
                  let bridgeVC = nav.viewControllers.first as? CAPBridgeViewController {
            bridgeVC.webView?.load(URLRequest(url: url))
        } else {
            // Fallback: walk the child hierarchy
            for child in rootVC.children {
                if let bridgeVC = child as? CAPBridgeViewController {
                    bridgeVC.webView?.load(URLRequest(url: url))
                    return
                }
            }
        }
    }
}
