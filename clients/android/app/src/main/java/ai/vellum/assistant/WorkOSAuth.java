package ai.vellum.assistant;

import android.net.Uri;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class WorkOSAuth {
    static final String API_BASE_URL = "https://api.workos.com";

    private static final String PROVIDER_ID = "workos";
    private static final String SCOPE = "openid profile email";
    private static final SecureRandom SECURE_RANDOM = new SecureRandom();

    private WorkOSAuth() {}

    static String generateBase64UrlToken() {
        byte[] bytes = new byte[32];
        SECURE_RANDOM.nextBytes(bytes);
        return base64UrlEncode(bytes);
    }

    static String codeChallenge(String verifier) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return base64UrlEncode(digest.digest(verifier.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    static Uri buildAuthorizeUri(
        String clientId,
        String redirectUri,
        String challenge,
        String state,
        String loginHint,
        String intent
    ) {
        Uri.Builder builder = Uri.parse(API_BASE_URL)
            .buildUpon()
            .appendPath("user_management")
            .appendPath("authorize")
            .appendQueryParameter("client_id", clientId)
            .appendQueryParameter("redirect_uri", redirectUri)
            .appendQueryParameter("response_type", "code")
            .appendQueryParameter("scope", SCOPE)
            .appendQueryParameter("code_challenge", challenge)
            .appendQueryParameter("code_challenge_method", "S256")
            .appendQueryParameter("state", state)
            .appendQueryParameter("provider", "authkit");

        String email = nonEmpty(loginHint);
        if (email != null) {
            builder.appendQueryParameter("login_hint", email);
        }
        if ("signup".equals(intent)) {
            builder.appendQueryParameter("screen_hint", "sign-up");
        }
        return builder.build();
    }

    static String selectClientId(String configBody) throws JSONException {
        JSONObject social = new JSONObject(configBody)
            .getJSONObject("data")
            .getJSONObject("socialaccount");
        JSONArray providers = social.getJSONArray("providers");

        for (int index = 0; index < providers.length(); index++) {
            JSONObject provider = providers.getJSONObject(index);
            if (!provider.isNull("openid_configuration_url")) {
                continue;
            }
            if (!hasFlow(provider.optJSONArray("flows"), "provider_token")) {
                continue;
            }
            String clientId = nonEmpty(provider.optString("client_id", null));
            if (clientId != null) {
                return clientId;
            }
        }
        return null;
    }

    static JSONObject authenticateRequestBody(String clientId, String code, String verifier)
        throws JSONException {
        JSONObject body = new JSONObject();
        body.put("client_id", clientId);
        body.put("grant_type", "authorization_code");
        body.put("code", code);
        body.put("code_verifier", verifier);
        return body;
    }

    static String accessToken(String authenticateBody) throws JSONException {
        return nonEmpty(new JSONObject(authenticateBody).optString("access_token", null));
    }

    static JSONObject providerTokenRequestBody(String clientId, String accessToken)
        throws JSONException {
        JSONObject token = new JSONObject();
        token.put("client_id", clientId);
        token.put("access_token", accessToken);

        JSONObject body = new JSONObject();
        body.put("provider", PROVIDER_ID);
        body.put("process", "login");
        body.put("token", token);
        return body;
    }

    static String sessionToken(String providerTokenBody) throws JSONException {
        return nonEmpty(new JSONObject(providerTokenBody)
            .getJSONObject("meta")
            .optString("session_token", null));
    }

    /**
     * Classify a non-200 from {@code /_allauth/app/v1/auth/provider/token} into a
     * machine-readable code the web layer maps to user-facing copy.
     *
     * <p>Without this every failure of the final exchange — the step that runs after
     * the browser tab closes, so the one the user experiences as "it errored the
     * moment I finished signing in with Google" — collapsed into a codeless
     * rejection and surfaced as "Something went wrong." The login screen already
     * knows how to explain {@code signup_closed}; it just never received it.
     *
     * <p>The three statuses are the ones the headless OpenAPI schema documents for
     * this endpoint (see {@code clients/web/src/generated/auth/types.gen.ts},
     * {@code PostAllauthByClientV1AuthProviderTokenErrors}):
     *
     * <ul>
     *   <li>{@code 403 ForbiddenResponse} — signup is closed. The body carries only
     *       {@code status}, so the status itself is the whole signal.
     *   <li>{@code 401 AuthenticationResponse} — authentication did not complete and
     *       {@code data.flows} names what is still pending. A pending
     *       {@code provider_signup} is the first-time-social-login case the browser
     *       flow sends to {@code /account/provider-signup}; anything else is a step
     *       this shell cannot run (email verification, MFA), reported as
     *       {@code login_incomplete}.
     *   <li>{@code 400 ErrorResponse} — an input error, with allauth's own code in
     *       {@code errors[0].code}.
     * </ul>
     *
     * <p>Returns {@code null} for any other status so the caller reports the raw
     * status instead of inventing a cause. Mirrors
     * {@code WorkOSAuth.sessionExchangeErrorCode} on iOS.
     */
    static String sessionExchangeErrorCode(int status, String body) {
        switch (status) {
            case 403:
                return "signup_closed";
            case 401:
                return pendingFlowCode(body);
            case 400:
                return inputErrorCode(body);
            default:
                return null;
        }
    }

    /**
     * {@code provider_signup} when that flow is the pending one, else the generic
     * "more steps are required" code. Matching on {@code is_pending} keeps this in
     * step with {@code classifyCallbackFlows()} on the browser side, which reads the
     * same field off the same response.
     */
    private static String pendingFlowCode(String body) {
        if (body == null || body.isEmpty()) {
            return "login_incomplete";
        }
        try {
            JSONArray flows = new JSONObject(body).getJSONObject("data").getJSONArray("flows");
            for (int index = 0; index < flows.length(); index++) {
                JSONObject flow = flows.getJSONObject(index);
                if ("provider_signup".equals(flow.optString("id", null)) && flow.optBoolean("is_pending", false)) {
                    return "provider_signup";
                }
            }
        } catch (JSONException e) {
            return "login_incomplete";
        }
        return "login_incomplete";
    }

    /**
     * allauth's own error code for a 400, or a generic stand-in when the body is
     * missing or shaped unexpectedly.
     */
    private static String inputErrorCode(String body) {
        if (body == null || body.isEmpty()) {
            return "invalid_request";
        }
        try {
            JSONArray errors = new JSONObject(body).getJSONArray("errors");
            if (errors.length() > 0) {
                String code = nonEmpty(errors.getJSONObject(0).optString("code", null));
                if (code != null) {
                    return code;
                }
            }
        } catch (JSONException e) {
            return "invalid_request";
        }
        return "invalid_request";
    }

    private static String base64UrlEncode(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private static boolean hasFlow(JSONArray flows, String needle) throws JSONException {
        if (flows == null) {
            return false;
        }
        for (int index = 0; index < flows.length(); index++) {
            if (needle.equals(flows.optString(index))) {
                return true;
            }
        }
        return false;
    }

    private static String nonEmpty(String value) {
        return value == null || value.isEmpty() ? null : value;
    }
}
