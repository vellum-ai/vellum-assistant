package ai.vellum.assistant;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.MalformedURLException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(name = "NativeAuth")
public class NativeAuthPlugin extends Plugin {
    private static final long CANCEL_ON_RESUME_GRACE_MS = 750L;
    private static final String AUTH_CALLBACK_HOST = "auth";
    private static final String AUTH_CALLBACK_PATH = "/callback";
    private static final String AUTH_ERROR_CODE = "AUTH_ERROR";
    private static final String AUTH_REPLACED_CODE = "AUTH_REPLACED";
    private static final String AUTH_STATE_STORE = "native_auth_state";
    private static final String CONFIG_PATH = "/_allauth/app/v1/config";
    private static final long FLOW_MAX_AGE_MS = 10 * 60 * 1000L;
    private static final String FLOW_ATTRIBUTION_KEY = "attribution";
    private static final String FLOW_BASE_URL_KEY = "base_url";
    private static final String FLOW_CLIENT_ID_KEY = "client_id";
    private static final String FLOW_CODE_VERIFIER_KEY = "code_verifier";
    private static final String FLOW_CREATED_AT_KEY = "created_at";
    private static final String FLOW_DESTINATION_KEY = "destination";
    private static final String FLOW_STATE_KEY = "state";
    private static final String PROVIDER_TOKEN_PATH = "/_allauth/app/v1/auth/provider/token";
    private static final String USER_CANCELLED_CODE = "USER_CANCELLED";
    private static final String WORKOS_AUTHENTICATE_PATH = "/user_management/authenticate";

    private final Object flowLock = new Object();
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    private AuthFlow flow;
    private JSObject restoredResult;
    private PluginCall restoredResultCall;

    @PluginMethod
    public void startAuth(PluginCall call) {
        String baseURLString = call.getString("baseURL");
        if (baseURLString == null || baseURLString.isEmpty()) {
            call.reject("Missing required option: baseURL");
            return;
        }

        Uri baseURL = Uri.parse(baseURLString);
        if (baseURL.getScheme() == null || baseURL.getHost() == null) {
            call.reject("Invalid baseURL: " + baseURLString);
            return;
        }
        if (!"https".equals(baseURL.getScheme())) {
            call.reject("Invalid baseURL: native auth requires https");
            return;
        }
        if (!isAllowedBaseURL(baseURL)) {
            call.reject(
                "Refusing auth: host "
                    + baseURL.getHost()
                    + " does not match build target ("
                    + getAllowedAuthHost()
                    + ")"
            );
            return;
        }

        AuthFlow nextFlow = new AuthFlow(
            call,
            baseURL,
            WorkOSAuth.generateBase64UrlToken(),
            WorkOSAuth.generateBase64UrlToken(),
            sanitizePostAuthDestination(call.getString("postAuthDestination")),
            readAttribution(call.getObject("attribution"))
        );
        replaceFlow(nextFlow);

        fetchWorkOSClientId(baseURL, new ClientIdCallback() {
            @Override
            public void onSuccess(String clientId) {
                synchronized (flowLock) {
                    if (flow != nextFlow) {
                        return;
                    }
                    nextFlow.clientId = clientId;
                }

                Uri authorizeUri = WorkOSAuth.buildAuthorizeUri(
                    clientId,
                    getCallbackUri(),
                    WorkOSAuth.codeChallenge(nextFlow.codeVerifier),
                    nextFlow.state,
                    call.getString("loginHint"),
                    call.getString("intent")
                );
                launchAuthBrowser(nextFlow, authorizeUri);
            }

            @Override
            public void onFailure(String message) {
                rejectFlow(nextFlow, message, null, null);
            }
        });
    }

    @PluginMethod
    public void consumeRestoredAuth(PluginCall call) {
        JSObject result;
        PluginCall previousCall = null;
        boolean waiting = false;
        synchronized (flowLock) {
            result = restoredResult;
            restoredResult = null;
            if (result == null && flow != null && flow.call == null && flow.callbackReceived) {
                previousCall = restoredResultCall;
                restoredResultCall = call;
                waiting = true;
            }
        }
        if (result != null) {
            call.resolve(result);
            return;
        }
        if (waiting) {
            if (previousCall != null) {
                previousCall.reject("Another restored auth consumer started", AUTH_REPLACED_CODE);
            }
            return;
        }
        call.resolve(new JSObject());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        Uri callbackUri = intent == null ? null : intent.getData();
        if (!isAuthCallback(callbackUri)) {
            return;
        }

        AuthFlow current;
        synchronized (flowLock) {
            current = flow;
            if (current == null) {
                // BridgeActivity forwards the initial launch intent here.
                current = restorePendingFlow();
                flow = current;
            }
            if (current != null) {
                current.callbackReceived = true;
            }
        }
        if (current == null) {
            return;
        }

        String authError = nonEmpty(callbackUri.getQueryParameter("error"));
        if (authError != null) {
            JSObject data = new JSObject();
            data.put("authError", authError);
            rejectFlow(current, "Auth error: " + authError, AUTH_ERROR_CODE, data);
            return;
        }

        String returnedState = nonEmpty(callbackUri.getQueryParameter("state"));
        if (returnedState == null) {
            rejectFlow(current, "Callback missing state", null, null);
            return;
        }
        if (!returnedState.equals(current.state)) {
            rejectFlow(current, "State mismatch; ignoring callback", null, null);
            return;
        }

        String code = nonEmpty(callbackUri.getQueryParameter("code"));
        if (code == null) {
            rejectFlow(current, "Callback missing authorization code", null, null);
            return;
        }

        exchangeForSession(current, code);
    }

    @Override
    protected void handleOnResume() {
        AuthFlow current;
        synchronized (flowLock) {
            current = flow;
        }
        if (current == null || !current.browserLaunched || current.callbackReceived) {
            return;
        }
        long remainingGrace = CANCEL_ON_RESUME_GRACE_MS - (SystemClock.elapsedRealtime() - current.browserLaunchTimeMs);
        if (remainingGrace <= 0) {
            rejectFlow(current, "User cancelled login", USER_CANCELLED_CODE, null);
            return;
        }
        AuthFlow expected = current;
        new Handler(Looper.getMainLooper()).postDelayed(
            () -> rejectIfBrowserReturnedWithoutCallback(expected),
            remainingGrace
        );
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
    }

    private void fetchWorkOSClientId(Uri baseURL, ClientIdCallback callback) {
        executor.execute(() -> {
            try {
                String configBody = getJson(buildPlatformURL(baseURL, CONFIG_PATH));
                String clientId = WorkOSAuth.selectClientId(configBody);
                if (clientId == null) {
                    callback.onFailure("Platform does not advertise a token-auth WorkOS provider");
                    return;
                }
                callback.onSuccess(clientId);
            } catch (IOException | JSONException e) {
                callback.onFailure("Failed to fetch auth config: " + e.getMessage());
            }
        });
    }

    private void launchAuthBrowser(AuthFlow expected, Uri authorizeUri) {
        runOnUiThread(() -> {
            if (!isCurrent(expected)) {
                return;
            }
            try {
                Activity activity = getActivity();
                if (activity == null) {
                    rejectFlow(expected, "No active activity is available to start login", null, null);
                    return;
                }
                Intent intent = new Intent(Intent.ACTION_VIEW, authorizeUri);
                intent.addCategory(Intent.CATEGORY_BROWSABLE);
                if (!persistPendingFlow(expected)) {
                    rejectFlow(expected, "Failed to persist native auth state", null, null);
                    return;
                }
                expected.browserLaunched = true;
                expected.browserLaunchTimeMs = SystemClock.elapsedRealtime();
                activity.startActivity(intent);
            } catch (ActivityNotFoundException e) {
                rejectFlow(expected, "No browser is available to start login", null, null);
            }
        });
    }

    private void rejectIfBrowserReturnedWithoutCallback(AuthFlow expected) {
        if (isCurrent(expected) && expected.browserLaunched && !expected.callbackReceived) {
            rejectFlow(expected, "User cancelled login", USER_CANCELLED_CODE, null);
        }
    }

    private void exchangeForSession(AuthFlow expected, String code) {
        executor.execute(() -> {
            try {
                if (expected.clientId == null) {
                    rejectFlow(expected, "Auth callback arrived before client configuration was ready", null, null);
                    return;
                }

                JSONObject workOSBody = WorkOSAuth.authenticateRequestBody(
                    expected.clientId,
                    code,
                    expected.codeVerifier
                );
                String workOSResponse = postJson(
                    new URL(WorkOSAuth.API_BASE_URL + WORKOS_AUTHENTICATE_PATH),
                    workOSBody
                );
                String accessToken = WorkOSAuth.accessToken(workOSResponse);
                if (accessToken == null) {
                    rejectFlow(expected, "WorkOS code exchange returned no access token", null, null);
                    return;
                }

                JSONObject sessionBody = WorkOSAuth.providerTokenRequestBody(expected.clientId, accessToken);
                String sessionResponse;
                try {
                    sessionResponse = postJson(
                        buildPlatformURL(
                            expected.baseURL,
                            PROVIDER_TOKEN_PATH,
                            Attribution.toQuery(expected.attribution)
                        ),
                        sessionBody
                    );
                } catch (HttpException e) {
                    // A non-200 here is the platform refusing the sign-in —
                    // signups closed, an unlinked provider account, a step this
                    // shell cannot run. Carry its cause across so the login
                    // screen can say which, and name the status in the message
                    // either way so a failure we have not classified is still
                    // diagnosable from a report.
                    String authError = WorkOSAuth.sessionExchangeErrorCode(e.status, e.body);
                    JSObject data = null;
                    if (authError != null) {
                        data = new JSObject();
                        data.put("authError", authError);
                    }
                    rejectFlow(
                        expected,
                        "Session exchange failed (HTTP " + e.status + ")",
                        authError == null ? null : AUTH_ERROR_CODE,
                        data
                    );
                    return;
                }

                String sessionToken = WorkOSAuth.sessionToken(sessionResponse);
                if (sessionToken == null) {
                    rejectFlow(expected, "Session exchange returned no session token", null, null);
                    return;
                }

                resolveFlow(expected, sessionToken);
            } catch (IOException | JSONException e) {
                rejectFlow(expected, "Session exchange failed: " + e.getMessage(), null, null);
            }
        });
    }

    private String getJson(URL url) throws IOException {
        HttpURLConnection connection = openConnection(url, "GET");
        try {
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                throw new HttpException(status, readErrorBody(connection));
            }
            return readBody(connection.getInputStream());
        } finally {
            connection.disconnect();
        }
    }

    private String postJson(URL url, JSONObject body) throws IOException {
        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
        HttpURLConnection connection = openConnection(url, "POST");
        try {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Content-Length", Integer.toString(payload.length));

            try (OutputStream stream = connection.getOutputStream()) {
                stream.write(payload);
            }

            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                throw new HttpException(status, readErrorBody(connection));
            }
            return readBody(connection.getInputStream());
        } finally {
            connection.disconnect();
        }
    }

    private HttpURLConnection openConnection(URL url, String method) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(15_000);
        connection.setRequestProperty("Accept", "application/json");
        return connection;
    }

    private URL buildPlatformURL(Uri baseURL, String path) throws IOException {
        return buildPlatformURL(baseURL, path, null);
    }

    /**
     * {@code path} on {@code baseURL}'s origin, carrying {@code encodedQuery}
     * verbatim when there is one.
     *
     * <p>Attribution rides the query string rather than the JSON body because
     * allauth headless posts {@code application/json}, which leaves Django's
     * {@code request.POST} empty; the platform reads these off
     * {@code request.GET} even for a POST.
     */
    private URL buildPlatformURL(Uri baseURL, String path, String encodedQuery) throws IOException {
        Uri origin = new Uri.Builder()
            .scheme(baseURL.getScheme())
            .encodedAuthority(baseURL.getEncodedAuthority())
            .encodedPath(path)
            .build();
        return withQuery(origin.toString(), encodedQuery);
    }

    /**
     * {@code base} carrying {@code encodedQuery}, or {@code base} alone when
     * there is no query. A {@code base} that already has a query or a fragment
     * is refused rather than given a second one.
     *
     * <p>Takes plain strings, so the append decision stays covered by JVM
     * tests: {@link Uri} is stubbed out of that source set.
     */
    static URL withQuery(String base, String encodedQuery) throws MalformedURLException {
        if (base.indexOf('?') >= 0 || base.indexOf('#') >= 0) {
            throw new MalformedURLException("Base URL carries its own query or fragment: " + base);
        }
        if (encodedQuery == null || encodedQuery.trim().isEmpty()) {
            return new URL(base);
        }
        return new URL(base + "?" + encodedQuery);
    }

    /**
     * The error body of a failed response, or {@code null} when there is none or it
     * cannot be read. Best-effort by design: the status alone already classifies
     * most failures, and losing the body must never mask the status.
     */
    private String readErrorBody(HttpURLConnection connection) {
        InputStream stream = connection.getErrorStream();
        if (stream == null) {
            return null;
        }
        try {
            return readBody(stream);
        } catch (IOException e) {
            return null;
        }
    }

    private String readBody(InputStream stream) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = stream.read(buffer)) != -1) {
            output.write(buffer, 0, read);
        }
        return output.toString(StandardCharsets.UTF_8.name());
    }

    private boolean isAuthCallback(Uri uri) {
        return uri != null
            && getAuthScheme().equals(uri.getScheme())
            && AUTH_CALLBACK_HOST.equals(uri.getHost())
            && AUTH_CALLBACK_PATH.equals(uri.getPath());
    }

    private String getCallbackUri() {
        return getAuthScheme() + "://" + AUTH_CALLBACK_HOST + AUTH_CALLBACK_PATH;
    }

    private boolean isAllowedBaseURL(Uri url) {
        String host = url.getHost();
        return host != null && host.toLowerCase(Locale.US).equals(getAllowedAuthHost());
    }

    private String getAllowedAuthHost() {
        return getContext().getString(R.string.vellum_auth_host).toLowerCase(Locale.US);
    }

    private String getAuthScheme() {
        return getContext().getString(R.string.vellum_auth_scheme);
    }

    private void replaceFlow(AuthFlow nextFlow) {
        AuthFlow previous;
        PluginCall previousRestoredCall = null;
        synchronized (flowLock) {
            previous = flow;
            flow = nextFlow;
            if (previous != null) {
                clearPendingFlow();
            }
            if (previous != null && previous.call == null) {
                previousRestoredCall = restoredResultCall;
                restoredResultCall = null;
            }
        }
        if (previous != null && previous.call != null) {
            previous.call.reject("Another auth flow started", AUTH_REPLACED_CODE);
        }
        if (previousRestoredCall != null) {
            previousRestoredCall.reject("Another auth flow started", AUTH_REPLACED_CODE);
        }
    }

    private boolean isCurrent(AuthFlow expected) {
        synchronized (flowLock) {
            return flow == expected;
        }
    }

    private FlowCompletion completeFlow(AuthFlow expected, JSObject restoredFlowResult) {
        synchronized (flowLock) {
            if (flow != expected) {
                return null;
            }
            AuthFlow current = flow;
            flow = null;
            clearPendingFlow();

            PluginCall restoredCall = null;
            if (current.call == null) {
                restoredCall = restoredResultCall;
                restoredResultCall = null;
                if (restoredCall == null) {
                    restoredResult = restoredFlowResult;
                }
            }
            return new FlowCompletion(current, restoredCall);
        }
    }

    private void resolveFlow(AuthFlow expected, String sessionToken) {
        JSObject result = new JSObject();
        result.put("sessionToken", sessionToken);
        result.put("postAuthDestination", expected.postAuthDestination);
        FlowCompletion completion = completeFlow(expected, result);
        if (completion == null) {
            return;
        }
        runOnUiThread(() -> {
            if (completion.flow.call != null) {
                completion.flow.call.resolve(result);
            } else if (completion.restoredCall != null) {
                completion.restoredCall.resolve(result);
            }
        });
    }

    private void rejectFlow(AuthFlow expected, String message, String code, JSObject data) {
        JSObject result = new JSObject();
        result.put("error", message);
        if (code != null) {
            result.put("errorCode", code);
        }
        FlowCompletion completion = completeFlow(expected, result);
        if (completion == null) {
            return;
        }
        runOnUiThread(() -> {
            if (completion.flow.call != null) {
                completion.flow.call.reject(message, code, null, data);
            } else if (completion.restoredCall != null) {
                completion.restoredCall.resolve(result);
            }
        });
    }

    private boolean persistPendingFlow(AuthFlow pendingFlow) {
        if (pendingFlow.clientId == null) {
            return false;
        }
        SharedPreferences.Editor editor = authStateStore().edit().clear();
        for (Map.Entry<String, String> field : pendingFlow.persisted().toFields().entrySet()) {
            editor.putString(field.getKey(), field.getValue());
        }
        return editor.putLong(FLOW_CREATED_AT_KEY, System.currentTimeMillis()).commit();
    }

    private AuthFlow restorePendingFlow() {
        SharedPreferences store = authStateStore();
        long createdAt = store.getLong(FLOW_CREATED_AT_KEY, 0L);
        long age = System.currentTimeMillis() - createdAt;
        if (createdAt <= 0L || age < 0L || age > FLOW_MAX_AGE_MS) {
            clearPendingFlow();
            return null;
        }

        PersistedFlow persisted = PersistedFlow.fromFields(storedFields(store));
        Uri baseURL = Uri.parse(persisted.baseURL);
        if (
            !"https".equals(baseURL.getScheme()) ||
            !isAllowedBaseURL(baseURL) ||
            persisted.clientId == null ||
            persisted.codeVerifier == null ||
            persisted.state == null
        ) {
            clearPendingFlow();
            return null;
        }

        AuthFlow restored = new AuthFlow(
            null,
            baseURL,
            persisted.state,
            persisted.codeVerifier,
            persisted.postAuthDestination,
            persisted.attribution
        );
        restored.clientId = persisted.clientId;
        restored.browserLaunched = true;
        return restored;
    }

    /** String-valued entries of {@code store}; the created-at stamp is a long. */
    private static Map<String, String> storedFields(SharedPreferences store) {
        Map<String, String> fields = new LinkedHashMap<>();
        for (Map.Entry<String, ?> entry : store.getAll().entrySet()) {
            if (entry.getValue() instanceof String) {
                fields.put(entry.getKey(), (String) entry.getValue());
            }
        }
        return fields;
    }

    private SharedPreferences authStateStore() {
        return getContext().getSharedPreferences(AUTH_STATE_STORE, Activity.MODE_PRIVATE);
    }

    private void clearPendingFlow() {
        authStateStore().edit().clear().commit();
    }

    /**
     * Allowlisted campaign attribution from a {@code startAuth} call. The
     * {@link JSObject} unwrap happens here so {@link Attribution} stays free of
     * Capacitor and Android types, and so stays testable on the JVM.
     *
     * <p>Only genuine strings survive: a number or a boolean is dropped rather
     * than coerced, matching the iOS shell.
     */
    static Map<String, String> readAttribution(JSObject source) {
        Map<String, String> raw = new LinkedHashMap<>();
        if (source != null) {
            for (String key : Attribution.KEYS) {
                Object value = source.opt(key);
                if (value instanceof String) {
                    raw.put(key, (String) value);
                }
            }
        }
        return Attribution.filter(raw);
    }

    private static String sanitizePostAuthDestination(String value) {
        if (value == null || !value.startsWith("/") || value.startsWith("//")) {
            return "/assistant";
        }
        return value;
    }

    private void runOnUiThread(Runnable runnable) {
        Activity activity = getActivity();
        if (activity == null) {
            runnable.run();
            return;
        }
        activity.runOnUiThread(runnable);
    }

    private static String nonEmpty(String value) {
        return value == null || value.isEmpty() ? null : value;
    }

    private interface ClientIdCallback {
        void onSuccess(String clientId);
        void onFailure(String message);
    }

    /**
     * A non-200 HTTP response, carrying the status and error body so a caller can
     * classify the failure. Still an {@link IOException}, so existing catch sites
     * that only want "the request failed" keep working unchanged.
     */
    private static final class HttpException extends IOException {
        final int status;
        final String body;

        HttpException(int status, String body) {
            super("HTTP " + status);
            this.status = status;
            this.body = body;
        }
    }

    private static final class AuthFlow {
        final PluginCall call;
        final Uri baseURL;
        final String state;
        final String codeVerifier;
        final String postAuthDestination;
        final Map<String, String> attribution;

        String clientId;
        boolean browserLaunched;
        boolean callbackReceived;
        long browserLaunchTimeMs;

        AuthFlow(
            PluginCall call,
            Uri baseURL,
            String state,
            String codeVerifier,
            String postAuthDestination,
            Map<String, String> attribution
        ) {
            this.call = call;
            this.baseURL = baseURL;
            this.state = state;
            this.codeVerifier = codeVerifier;
            this.postAuthDestination = postAuthDestination;
            this.attribution = attribution;
        }

        PersistedFlow persisted() {
            return new PersistedFlow(
                baseURL.toString(),
                clientId,
                codeVerifier,
                state,
                postAuthDestination,
                attribution
            );
        }
    }

    /**
     * The half of an {@link AuthFlow} that outlives the process, in the form the
     * auth state store holds it. Free of Android types, so the pairing of
     * {@link #toFields} with {@link #fromFields} is covered by JVM tests.
     */
    static final class PersistedFlow {
        final String baseURL;
        final String clientId;
        final String codeVerifier;
        final String state;
        final String postAuthDestination;
        final Map<String, String> attribution;

        PersistedFlow(
            String baseURL,
            String clientId,
            String codeVerifier,
            String state,
            String postAuthDestination,
            Map<String, String> attribution
        ) {
            this.baseURL = baseURL;
            this.clientId = clientId;
            this.codeVerifier = codeVerifier;
            this.state = state;
            this.postAuthDestination = postAuthDestination;
            this.attribution = attribution;
        }

        Map<String, String> toFields() {
            Map<String, String> fields = new LinkedHashMap<>();
            fields.put(FLOW_ATTRIBUTION_KEY, Attribution.toQuery(attribution));
            fields.put(FLOW_BASE_URL_KEY, baseURL);
            fields.put(FLOW_CLIENT_ID_KEY, clientId);
            fields.put(FLOW_CODE_VERIFIER_KEY, codeVerifier);
            fields.put(FLOW_DESTINATION_KEY, postAuthDestination);
            fields.put(FLOW_STATE_KEY, state);
            return fields;
        }

        /**
         * What {@link #toFields} wrote, read back. A value no flow can run on
         * comes back null so the caller rejects the flow; a missing attribution
         * degrades to an empty map instead.
         */
        static PersistedFlow fromFields(Map<String, String> fields) {
            String baseURL = fields.get(FLOW_BASE_URL_KEY);
            return new PersistedFlow(
                baseURL == null ? "" : baseURL,
                nonEmpty(fields.get(FLOW_CLIENT_ID_KEY)),
                nonEmpty(fields.get(FLOW_CODE_VERIFIER_KEY)),
                nonEmpty(fields.get(FLOW_STATE_KEY)),
                sanitizePostAuthDestination(fields.get(FLOW_DESTINATION_KEY)),
                Attribution.parseQuery(fields.get(FLOW_ATTRIBUTION_KEY))
            );
        }
    }

    private static final class FlowCompletion {
        final AuthFlow flow;
        final PluginCall restoredCall;

        FlowCompletion(AuthFlow flow, PluginCall restoredCall) {
            this.flow = flow;
            this.restoredCall = restoredCall;
        }
    }
}
