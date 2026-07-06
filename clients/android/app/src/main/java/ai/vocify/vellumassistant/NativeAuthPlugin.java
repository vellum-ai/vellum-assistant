package ai.vocify.vellumassistant;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
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
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
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
    private static final String CONFIG_PATH = "/_allauth/app/v1/config";
    private static final String PROVIDER_TOKEN_PATH = "/_allauth/app/v1/auth/provider/token";
    private static final String USER_CANCELLED_CODE = "USER_CANCELLED";
    private static final String WORKOS_AUTHENTICATE_PATH = "/user_management/authenticate";

    private final Object flowLock = new Object();
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    private AuthFlow flow;

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
            WorkOSAuth.generateBase64UrlToken()
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
                    call.getString("providerHint"),
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

    @Override
    protected void handleOnNewIntent(Intent intent) {
        Uri callbackUri = intent == null ? null : intent.getData();
        if (!isAuthCallback(callbackUri)) {
            return;
        }

        AuthFlow current;
        synchronized (flowLock) {
            current = flow;
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
                String sessionResponse = postJson(
                    buildPlatformURL(expected.baseURL, PROVIDER_TOKEN_PATH),
                    sessionBody
                );
                String sessionToken = WorkOSAuth.sessionToken(sessionResponse);
                if (sessionToken == null) {
                    rejectFlow(expected, "Session exchange returned invalid response", null, null);
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
                throw new IOException("HTTP " + status);
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
                throw new IOException("HTTP " + status);
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
        Uri uri = new Uri.Builder()
            .scheme(baseURL.getScheme())
            .encodedAuthority(baseURL.getEncodedAuthority())
            .encodedPath(path)
            .build();
        return new URL(uri.toString());
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
        synchronized (flowLock) {
            previous = flow;
            flow = nextFlow;
        }
        if (previous != null) {
            previous.call.reject("Another auth flow started", AUTH_REPLACED_CODE);
        }
    }

    private boolean isCurrent(AuthFlow expected) {
        synchronized (flowLock) {
            return flow == expected;
        }
    }

    private AuthFlow takeFlow(AuthFlow expected) {
        synchronized (flowLock) {
            if (flow != expected) {
                return null;
            }
            AuthFlow current = flow;
            flow = null;
            return current;
        }
    }

    private void resolveFlow(AuthFlow expected, String sessionToken) {
        AuthFlow current = takeFlow(expected);
        if (current == null) {
            return;
        }
        runOnUiThread(() -> {
            JSObject result = new JSObject();
            result.put("sessionToken", sessionToken);
            current.call.resolve(result);
        });
    }

    private void rejectFlow(AuthFlow expected, String message, String code, JSObject data) {
        AuthFlow current = takeFlow(expected);
        if (current == null) {
            return;
        }
        runOnUiThread(() -> current.call.reject(message, code, null, data));
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

    private static final class AuthFlow {
        final PluginCall call;
        final Uri baseURL;
        final String state;
        final String codeVerifier;

        String clientId;
        boolean browserLaunched;
        boolean callbackReceived;
        long browserLaunchTimeMs;

        AuthFlow(PluginCall call, Uri baseURL, String state, String codeVerifier) {
            this.call = call;
            this.baseURL = baseURL;
            this.state = state;
            this.codeVerifier = codeVerifier;
        }
    }
}
