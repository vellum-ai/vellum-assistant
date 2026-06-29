package ai.vocify.vellumassistant;

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
        String providerHint,
        String intent
    ) {
        String provider = nonEmpty(providerHint);
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
            .appendQueryParameter("provider", provider != null ? provider : "authkit");

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
