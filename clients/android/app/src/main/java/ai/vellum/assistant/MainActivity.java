package ai.vellum.assistant;

import android.app.AlertDialog;
import android.content.Intent;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.widget.ImageView;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.CapConfig;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginLoadException;
import com.getcapacitor.PluginManager;
import java.io.IOException;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONException;

public class MainActivity extends BridgeActivity {
    private static final long LAUNCH_SCREEN_LOAD_FALLBACK_MS = 2_000;
    private static final long LAUNCH_SCREEN_TIMEOUT_MS = 15_000;

    /**
     * The way out of an origin that cannot be reached, as a route under the app
     * entry: the baked Vellum Cloud origin serves the chooser whether or not
     * the configured one is up, and the chooser lists every remembered origin,
     * so the unreachable one is still one tap away once it recovers.
     * {@code noAutoSkip} keeps it from connecting straight through a lone
     * assistant. Mirrors the pairing page's cancel route.
     */
    private static final String CHOOSER_ROUTE_PATH = "select-assistant?noAutoSkip=1";

    private static ConnectDeepLink recreationConnect;
    private static String recreationRoutePath;

    private final Handler launchScreenHandler = new Handler(Looper.getMainLooper());
    private AlertDialog unreachableDialog;
    private URI effectiveServer;
    private URI pendingAppLink;
    private ConnectDeepLink pendingConnect;
    private boolean pendingNewChat;
    private Intent pendingVoiceLaunch;
    private View launchScreen;
    private boolean launchScreenReady;
    private SafeWebChromeClient webChromeClient;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        NativeFailureGuard.initialize(this);
        NativeFailureGuard.run(
            "Unable to apply the Android launch theme",
            () -> NativeLaunchScreenPlugin.applySavedTheme(this)
        );
        boolean recoveredProcess = NativeFailureGuard.get(
            "Unable to clear the recovered voice status",
            () -> VoiceLiveActivityPlugin.clearRecoveredStatus(this),
            false
        );
        NativeFailureGuard.run("Unable to normalize the Android launch intent", () -> {
            if (
                VoiceDeepLink.shouldSuppressRecoveredStatusLaunch(
                    recoveredProcess,
                    VoiceDeepLink.isStatusNotificationIntent(getIntent())
                )
            ) {
                setIntent(VoiceDeepLink.clearedCommandIntent(getIntent()));
            }
        });
        NativeFailureGuard.run(
            "Unable to prepare the Android voice launch",
            () -> prepareVoiceLaunch(getIntent())
        );
        pendingConnect = NativeFailureGuard.get(
            "Unable to read the Android connect launch",
            () -> {
                ConnectDeepLink connect = takeRecreationConnect();
                return connect == null ? consumeConnectIntent(getIntent()) : connect;
            },
            null
        );
        URI selectedServer = pendingConnect == null
            ? NativeFailureGuard.get(
                "Unable to read the saved self-hosted server",
                () -> SelfHostedServer.configured(this),
                null
            )
            : pendingConnect.server();
        configureServer(selectedServer);
        pendingAppLink = NativeFailureGuard.get(
            "Unable to read the Android app link",
            () -> consumeAppLinkIntent(getIntent()),
            null
        );
        super.onCreate(savedInstanceState);
        NativeFailureGuard.run("Unable to show the Android launch screen", this::showLaunchScreen);
        NativeFailureGuard.run("Unable to deliver the Android voice launch", this::deliverPendingVoiceLaunch);
        NativeFailureGuard.run("Unable to configure the Android WebView", () -> {
            if (bridge != null) {
                webChromeClient = new SafeWebChromeClient(bridge);
                bridge.getWebView().setWebChromeClient(webChromeClient);
                bridge.setWebViewClient(new SelfHostedWebViewClient(bridge, this));
            }
        });
        NativeFailureGuard.run("Unable to deliver the Android app link", this::deliverPendingAppLink);
        NativeFailureGuard.run("Unable to deliver the Android connect launch", this::deliverPendingConnect);
        NativeFailureGuard.run("Unable to deliver the Android new chat launch", this::deliverPendingNewChat);
        NativeFailureGuard.run("Unable to deliver the Android route launch", this::deliverPendingRoute);
    }

    @Override
    protected void load() {
        List<Class<? extends Plugin>> plugins;
        try {
            plugins = new PluginManager(getAssets()).loadPluginClasses();
            plugins.removeIf(PushNotificationsPlugin.class::equals);
        } catch (PluginLoadException exception) {
            NativeFailureGuard.record("Unable to load Capacitor plugins", exception);
            plugins = new ArrayList<>();
        }
        bridgeBuilder.setPlugins(plugins);
        registerPlugin(NativeAuthPlugin.class);
        registerPlugin(NativeBiometricPlugin.class);
        registerPlugin(NativeFailureReportsPlugin.class);
        registerPlugin(NativeLaunchScreenPlugin.class);
        registerPlugin(AndroidNotificationChannelsPlugin.class);
        registerPlugin(AndroidNotificationSettingsPlugin.class);
        registerPlugin(AndroidPushRegistrationPlugin.class);
        registerPlugin(InstallReferrerPlugin.class);
        registerPlugin(VoiceAudioSessionPlugin.class);
        registerPlugin(VoiceLiveActivityPlugin.class);
        registerPlugin(SelfHostedServersPlugin.class);
        registerPlugin(SafePushNotificationsPlugin.class);
        super.load();
    }

    private void showLaunchScreen() {
        if (launchScreenReady) {
            return;
        }
        ImageView view = new ImageView(this);
        view.setBackgroundColor(NativeLaunchScreenPlugin.backgroundColor(this));
        view.setImageResource(R.drawable.vellum_mark);
        view.setColorFilter(NativeLaunchScreenPlugin.foregroundColor(this));
        view.setScaleType(ImageView.ScaleType.CENTER);
        view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        addContentView(
            view,
            new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        );
        launchScreen = view;
        scheduleLaunchScreenFallback(LAUNCH_SCREEN_TIMEOUT_MS);
    }

    void hideLaunchScreen() {
        launchScreenReady = true;
        launchScreenHandler.removeCallbacksAndMessages(null);
        if (launchScreen == null) {
            return;
        }
        ViewGroup parent = (ViewGroup) launchScreen.getParent();
        if (parent != null) {
            parent.removeView(launchScreen);
        }
        launchScreen = null;
    }

    private void scheduleLaunchScreenFallback(long delayMs) {
        if (launchScreenReady) {
            return;
        }
        launchScreenHandler.removeCallbacksAndMessages(null);
        launchScreenHandler.postDelayed(this::hideLaunchScreen, delayMs);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        URI appLink = consumeAppLinkIntent(intent);
        if (appLink != null) {
            super.onNewIntent(withoutData(intent));
            pendingAppLink = appLink;
            deliverPendingAppLink();
            return;
        }

        VoiceDeepLink.Command voiceCommand = VoiceDeepLink.parse(
            intent,
            getString(R.string.vellum_auth_scheme)
        );
        if (voiceCommand == VoiceDeepLink.Command.NEW_CHAT) {
            super.onNewIntent(VoiceDeepLink.clearedCommandIntent(intent));
            pendingNewChat = true;
            deliverPendingNewChat();
            return;
        }
        if (VoiceDeepLink.isVoiceCommand(voiceCommand)) {
            Intent delivered = VoiceDeepLink.needsNormalization(intent)
                ? VoiceDeepLink.normalizedVoiceIntent(
                    intent,
                    getString(R.string.vellum_auth_scheme),
                    voiceCommand
                )
                : intent;
            super.onNewIntent(delivered);
            setIntent(VoiceDeepLink.clearedCommandIntent(delivered));
            return;
        }

        boolean handlesConnect = isConnectIntent(intent);
        ConnectDeepLink connect = handlesConnect ? consumeConnectIntent(intent) : null;
        if (connect == null) {
            super.onNewIntent(intent);
            return;
        }

        super.onNewIntent(intent);

        if (effectiveServer == null || !effectiveServer.equals(connect.server())) {
            setRecreationConnect(connect);
            // A stale switch route must not load over the pair page.
            setRecreationRoutePath(null);
            setIntent(withoutData(intent));
            recreate();
            return;
        }
        pendingConnect = connect;
        deliverPendingConnect();
    }

    @Override
    public void onDestroy() {
        launchScreenHandler.removeCallbacksAndMessages(null);
        if (webChromeClient != null) {
            webChromeClient.destroy();
            webChromeClient = null;
        }
        if (unreachableDialog != null) {
            unreachableDialog.dismiss();
            unreachableDialog = null;
        }
        super.onDestroy();
    }

    private void configureServer(URI selectedServer) {
        effectiveServer = selectedServer;
        try {
            config = selectedServer == null
                ? CapConfig.loadDefault(this)
                : SelfHostedServer.overrideCapacitorConfig(this, selectedServer);
        } catch (IOException | JSONException | RuntimeException exception) {
            NativeFailureGuard.record(
                "Unable to apply the self-hosted server configuration",
                exception
            );
            effectiveServer = null;
            try {
                config = CapConfig.loadDefault(this);
            } catch (RuntimeException fallbackException) {
                NativeFailureGuard.record(
                    "Unable to load the Android app configuration",
                    fallbackException
                );
                config = new CapConfig.Builder(this).create();
            }
        }
    }

    private ConnectDeepLink consumeConnectIntent(Intent intent) {
        if (!isConnectIntent(intent)) {
            return null;
        }
        String raw = intent.getDataString();
        intent.setData(null);
        setIntent(withoutData(intent));
        ConnectDeepLink connect = ConnectDeepLink.parse(raw, getString(R.string.vellum_auth_scheme));
        if (connect != null) {
            // Remember the origin the moment the link arrives, as iOS does: a
            // tunnel already down never reaches onPageFinished, so one recorded
            // only on success is one the chooser can never offer back. What
            // pairing still has to earn stays deferred, so an unreachable server
            // neither displaces the active one nor relabels a card it already has.
            SelfHostedServer.appendIfAbsent(this, connect.server(), connect.name());
        }
        return connect;
    }

    private boolean isConnectIntent(Intent intent) {
        return intent != null
            && ConnectDeepLink.handles(intent.getDataString(), getString(R.string.vellum_auth_scheme));
    }

    private URI consumeAppLinkIntent(Intent intent) {
        if (
            intent == null
                || !Intent.ACTION_VIEW.equals(intent.getAction())
                || effectiveServer != null
                || pendingConnect != null
        ) {
            return null;
        }
        URI appLink = AndroidAppLink.parse(
            intent.getDataString(),
            getString(R.string.vellum_auth_host)
        );
        if (appLink == null) {
            return null;
        }
        intent.setData(null);
        setIntent(withoutData(intent));
        return appLink;
    }

    private Intent withoutData(Intent intent) {
        Intent sanitized = intent == null ? new Intent() : new Intent(intent);
        sanitized.setData(null);
        return sanitized;
    }

    private void deliverPendingConnect() {
        if (pendingConnect == null || bridge == null || effectiveServer == null) {
            return;
        }
        bridge.getWebView().loadUrl(pendingConnect.pairPage().toASCIIString());
    }

    private void deliverPendingAppLink() {
        if (pendingAppLink == null || bridge == null) {
            return;
        }
        if (effectiveServer != null || pendingConnect != null) {
            pendingAppLink = null;
            return;
        }
        URI appLink = pendingAppLink;
        pendingAppLink = null;
        bridge.getWebView().loadUrl(appLink.toASCIIString());
    }

    /**
     * Promote the pending server once its pair page loads: the active slot, plus
     * the label that {@link #consumeConnectIntent} withheld from an origin the
     * list already knew.
     */
    private void finishPendingConnect(String loadedUrl) {
        if (
            pendingConnect == null ||
            !SelfHostedServer.samePage(pendingConnect.pairPage().toASCIIString(), loadedUrl)
        ) {
            return;
        }
        SelfHostedServer.activate(this, pendingConnect.server(), pendingConnect.name());
        pendingConnect = null;
    }

    private void handleServerFailure(String failedUrl) {
        if (!SelfHostedServer.contains(effectiveServer, failedUrl)) {
            return;
        }
        if (unreachableDialog != null && unreachableDialog.isShowing()) {
            return;
        }
        if (isFinishing() || isDestroyed()) {
            return;
        }

        // A dead tunnel answers with its provider's own error page, which
        // offers no way back into the app; blanking it leaves this dialog as
        // the whole error state, matching the iOS response cancellation. Sits
        // below the guards so an unrelated failure keeps the WebView's own
        // error page.
        if (bridge != null) {
            bridge.getWebView().loadUrl("about:blank");
        }

        String host = effectiveServer.getHost();
        unreachableDialog = new AlertDialog.Builder(this)
            .setTitle("Can't reach " + host)
            .setMessage("The assistant may be offline or unreachable from this device.")
            .setPositiveButton("Retry", (dialog, which) -> retryServer())
            .setNegativeButton("Choose Assistant", (dialog, which) -> openAssistantChooser())
            // Dismissing without choosing would leave a blank page and no way
            // out, which is the state this dialog exists to end.
            .setCancelable(false)
            .setOnDismissListener(dialog -> unreachableDialog = null)
            .create();
        unreachableDialog.show();
    }

    private void retryServer() {
        if (bridge == null || effectiveServer == null) {
            return;
        }
        String destination = pendingConnect == null
            ? SelfHostedServer.appEntryUrl(effectiveServer).toASCIIString()
            : pendingConnect.pairPage().toASCIIString();
        bridge.getWebView().loadUrl(destination);
    }

    /**
     * Leave the unreachable origin for the chooser on the baked Vellum Cloud
     * origin, which is up whether or not the configured one is. Clearing unsets
     * only the active slot, so the remembered list keeps the origin and the
     * chooser offers it back once it recovers.
     */
    private void openAssistantChooser() {
        SelfHostedServer.clear(this);
        effectiveServer = null;
        recreateForServerChange(CHOOSER_ROUTE_PATH);
    }

    /**
     * Recreate onto whatever server slot {@link SelfHostedServer} now holds,
     * plus an optional initial in-app route to load once the new origin is up.
     * The caller has already written the slot; onCreate re-reads everything,
     * so no field needs resetting beyond the pending launch state.
     */
    void recreateForServerChange(String routePath) {
        // A connect deep link may have planted a recreation while this call's
        // runnable sat queued (recreate() flips neither isFinishing nor
        // isDestroyed); the pairing navigation wins, so never discard it.
        if (hasRecreationConnect()) {
            return;
        }
        // A live voice session does not survive an origin swap.
        VoiceLiveActivityPlugin.clearStatus(this);
        pendingConnect = null;
        pendingNewChat = false;
        setRecreationConnect(null);
        setRecreationRoutePath(routePath);
        setIntent(withoutData(getIntent()));
        recreate();
    }

    private void prepareVoiceLaunch(Intent intent) {
        VoiceDeepLink.Command command = VoiceDeepLink.parse(intent, getString(R.string.vellum_auth_scheme));
        if (command == VoiceDeepLink.Command.NEW_CHAT) {
            pendingNewChat = true;
            setIntent(VoiceDeepLink.clearedCommandIntent(intent));
            return;
        }
        if (!VoiceDeepLink.isVoiceCommand(command)) {
            return;
        }
        pendingVoiceLaunch = VoiceDeepLink.needsNormalization(intent)
            ? VoiceDeepLink.normalizedVoiceIntent(
                intent,
                getString(R.string.vellum_auth_scheme),
                command
            )
            : new Intent(intent);
        setIntent(VoiceDeepLink.clearedCommandIntent(intent));
    }

    private void deliverPendingVoiceLaunch() {
        if (pendingVoiceLaunch == null) {
            return;
        }
        Intent launch = pendingVoiceLaunch;
        pendingVoiceLaunch = null;
        super.onNewIntent(launch);
    }

    private void deliverPendingNewChat() {
        if (!pendingNewChat || bridge == null || bridge.getServerUrl() == null) {
            return;
        }
        pendingNewChat = false;
        bridge.getWebView().loadUrl(bridge.getServerUrl());
    }

    /**
     * Load a route stashed by {@link #recreateForServerChange(String)}.
     * bridge.getServerUrl() is already the app entry URL (override or baked);
     * an unusable route silently falls back to the default entry load.
     */
    private void deliverPendingRoute() {
        String path = takeRecreationRoutePath();
        // Pair-page navigation wins over a stashed route.
        if (path == null || pendingConnect != null || bridge == null || bridge.getServerUrl() == null) {
            return;
        }
        String route = SelfHostedServer.appRoute(bridge.getServerUrl(), path);
        if (route != null) {
            bridge.getWebView().loadUrl(route);
        }
    }

    private static synchronized String takeRecreationRoutePath() {
        String path = recreationRoutePath;
        recreationRoutePath = null;
        return path;
    }

    private static synchronized void setRecreationRoutePath(String path) {
        recreationRoutePath = path;
    }

    private static synchronized ConnectDeepLink takeRecreationConnect() {
        ConnectDeepLink connect = recreationConnect;
        recreationConnect = null;
        return connect;
    }

    private static synchronized void setRecreationConnect(ConnectDeepLink connect) {
        recreationConnect = connect;
    }

    private static synchronized boolean hasRecreationConnect() {
        return recreationConnect != null;
    }

    private static final class SelfHostedWebViewClient extends BridgeWebViewClient {
        private final MainActivity activity;
        private String mainFrameUrl;
        private boolean mainFrameFailed;

        SelfHostedWebViewClient(Bridge bridge, MainActivity activity) {
            super(bridge);
            this.activity = activity;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            VoiceAudioSessionPlugin.releaseForPageLoad(activity);
            activity.scheduleLaunchScreenFallback(LAUNCH_SCREEN_TIMEOUT_MS);
            mainFrameUrl = url;
            mainFrameFailed = false;
            super.onPageStarted(view, url, favicon);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (!mainFrameFailed) {
                activity.finishPendingConnect(url);
                activity.scheduleLaunchScreenFallback(LAUNCH_SCREEN_LOAD_FALLBACK_MS);
            }
        }

        @Override
        public boolean onRenderProcessGone(
            WebView view,
            android.webkit.RenderProcessGoneDetail detail
        ) {
            VoiceAudioSessionPlugin.releaseForPageLoad(activity);
            return super.onRenderProcessGone(view, detail);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request.isForMainFrame()) {
                fail(request.getUrl().toString());
            }
        }

        @Override
        public void onReceivedHttpError(
            WebView view,
            WebResourceRequest request,
            WebResourceResponse errorResponse
        ) {
            super.onReceivedHttpError(view, request, errorResponse);
            if (request.isForMainFrame()) {
                fail(request.getUrl().toString());
            }
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            super.onReceivedSslError(view, handler, error);
            if (SelfHostedServer.samePage(error.getUrl(), mainFrameUrl)) {
                fail(error.getUrl());
            }
        }

        private void fail(String url) {
            mainFrameFailed = true;
            activity.hideLaunchScreen();
            activity.handleServerFailure(url);
        }
    }
}
