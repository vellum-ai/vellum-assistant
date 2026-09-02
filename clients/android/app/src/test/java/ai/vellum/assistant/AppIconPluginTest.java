package ai.vellum.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import android.content.pm.PackageManager;
import com.getcapacitor.JSObject;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

public class AppIconPluginTest {
    private static final String PRIMARY_ALIAS = "ai.vellum.assistant.icon.primary";
    private static final String GRUMPY_GREEN = "avatar-eyes-grumpy-green";
    private static final String GRUMPY_GREEN_ALIAS = "ai.vellum.assistant.icon.avatar_eyes_grumpy_green";
    private static final String GOOFY_TEAL = "avatar-eyes-goofy-teal";
    private static final String GOOFY_TEAL_ALIAS = "ai.vellum.assistant.icon.avatar_eyes_goofy_teal";

    /** A build's aliases as {@code PackageInfo} reports them, primary first. */
    private static final List<String> ALIASES = Arrays.asList(
        PRIMARY_ALIAS,
        GRUMPY_GREEN_ALIAS,
        GOOFY_TEAL_ALIAS
    );

    /**
     * Candidate locations of the plugin source, so the guard test below finds it
     * whether the runner starts in the module, the Android project, or the repo.
     */
    private static final List<String> SOURCE_PATHS = Arrays.asList(
        "src/main/java/ai/vellum/assistant/AppIconPlugin.java",
        "app/src/main/java/ai/vellum/assistant/AppIconPlugin.java",
        "clients/android/app/src/main/java/ai/vellum/assistant/AppIconPlugin.java"
    );

    @Test
    public void translatesBetweenWireNamesAndAliasClassNames() {
        assertEquals(GRUMPY_GREEN, AppIconPlugin.wireNameForAlias(GRUMPY_GREEN_ALIAS));
        assertEquals(GRUMPY_GREEN_ALIAS, AppIconPlugin.aliasForWireName(GRUMPY_GREEN));
        // Colors can carry their own dash, so the swap is whole-string.
        assertEquals(
            "ai.vellum.assistant.icon.avatar_eyes_curious_cosmic_purple",
            AppIconPlugin.aliasForWireName("avatar-eyes-curious-cosmic-purple")
        );
        assertEquals(
            "avatar-eyes-curious-cosmic-purple",
            AppIconPlugin.wireNameForAlias("ai.vellum.assistant.icon.avatar_eyes_curious_cosmic_purple")
        );
    }

    @Test
    public void refusesNamesAndClassesThatAreNotAlternateAliases() {
        assertNull(AppIconPlugin.wireNameForAlias(null));
        assertNull(AppIconPlugin.wireNameForAlias("ai.vellum.assistant.SomeOtherActivity"));
        assertNull(AppIconPlugin.aliasForWireName(null));
        assertNull(AppIconPlugin.aliasForWireName(""));
    }

    @Test
    public void excludesThePrimaryAliasFromAvailableAndSortsWhatIsLeft() {
        List<String> available = AppIconPlugin.wireNames(ALIASES);

        assertEquals(Arrays.asList(GOOFY_TEAL, GRUMPY_GREEN), available);
        assertNull(AppIconPlugin.wireNameForAlias(PRIMARY_ALIAS));
        assertNull(AppIconPlugin.aliasForWireName("primary"));
    }

    @Test
    public void ignoresActivitiesOutsideTheAliasNamespace() {
        List<String> available = AppIconPlugin.wireNames(
            Arrays.asList("ai.vellum.assistant.SomeOtherActivity", GRUMPY_GREEN_ALIAS)
        );

        assertEquals(Collections.singletonList(GRUMPY_GREEN), available);
    }

    @Test
    public void aRecordedTargetOutranksTheAliasStillEnabled() {
        assertEquals(GOOFY_TEAL, AppIconPlugin.currentWireName(GOOFY_TEAL_ALIAS, GRUMPY_GREEN_ALIAS));
        assertEquals(GRUMPY_GREEN, AppIconPlugin.currentWireName(null, GRUMPY_GREEN_ALIAS));
    }

    @Test
    public void thePrimaryAliasReadsBackAsTheDefaultIcon() {
        assertNull(AppIconPlugin.currentWireName(null, null));
        assertNull(AppIconPlugin.currentWireName(PRIMARY_ALIAS, GRUMPY_GREEN_ALIAS));
    }

    @Test
    public void anAbsentNameTargetsThePrimaryAlias() {
        assertEquals(PRIMARY_ALIAS, AppIconPlugin.targetAlias(null, ALIASES));
    }

    @Test
    public void onlyBundledAlternatesAreTargetable() {
        assertEquals(GRUMPY_GREEN_ALIAS, AppIconPlugin.targetAlias(GRUMPY_GREEN, ALIASES));
        assertNull(AppIconPlugin.targetAlias("avatar-eyes-smitten-chartreuse", ALIASES));
        assertNull(AppIconPlugin.targetAlias("primary", ALIASES));
        assertNull(AppIconPlugin.targetAlias("", ALIASES));
    }

    @Test
    public void theDefaultIconResolvesAJsonNullCurrent() throws JSONException {
        JSObject payload = AppIconPlugin.statePayload(true, null, Collections.emptyList());

        assertTrue(payload.getBoolean("supported"));
        assertTrue(payload.has("current"));
        assertTrue(payload.isNull("current"));
        assertSame(JSONObject.NULL, payload.get("current"));
        assertEquals(0, payload.getJSONArray("available").length());
    }

    @Test
    public void anAppliedIconResolvesItsWireName() throws JSONException {
        JSObject payload = AppIconPlugin.statePayload(
            false,
            GRUMPY_GREEN,
            Arrays.asList(GOOFY_TEAL, GRUMPY_GREEN)
        );

        assertFalse(payload.getBoolean("supported"));
        assertEquals(GRUMPY_GREEN, payload.getString("current"));
        JSONArray available = payload.getJSONArray("available");
        assertEquals(2, available.length());
        assertEquals(GOOFY_TEAL, available.getString(0));
        assertEquals(GRUMPY_GREEN, available.getString(1));
    }

    /**
     * A device that applied an alternate holds an explicit disable on the
     * primary alias, and that override survives an install that no longer
     * declares the alternate: the applied alias drops out of the build's
     * aliases and nothing is left to launch, so the primary goes back on.
     */
    @Test
    public void restoresThePrimaryWhenNoDeclaredAliasDrawsTheApp() {
        Map<String, Integer> enabledSettings = new LinkedHashMap<>();
        enabledSettings.put(PRIMARY_ALIAS, PackageManager.COMPONENT_ENABLED_STATE_DISABLED);
        enabledSettings.put(GRUMPY_GREEN_ALIAS, PackageManager.COMPONENT_ENABLED_STATE_DISABLED);
        // An alternate left at the manifest default is disabled, not drawing.
        enabledSettings.put(GOOFY_TEAL_ALIAS, PackageManager.COMPONENT_ENABLED_STATE_DEFAULT);

        assertTrue(AppIconPlugin.restoresPrimaryAlias(enabledSettings));
    }

    @Test
    public void leavesTheLauncherAloneWhileAnAlternateIsEnabled() {
        Map<String, Integer> enabledSettings = new LinkedHashMap<>();
        enabledSettings.put(PRIMARY_ALIAS, PackageManager.COMPONENT_ENABLED_STATE_DISABLED);
        enabledSettings.put(GRUMPY_GREEN_ALIAS, PackageManager.COMPONENT_ENABLED_STATE_ENABLED);
        enabledSettings.put(GOOFY_TEAL_ALIAS, PackageManager.COMPONENT_ENABLED_STATE_DISABLED);

        assertFalse(AppIconPlugin.restoresPrimaryAlias(enabledSettings));
    }

    /**
     * A recorded target is applied before the invariant is checked, so the
     * restore only ever reads the state that pass left: the primary back at the
     * manifest default for a reset, or the target alternate enabled. Neither
     * needs a second write.
     */
    @Test
    public void anAppliedTargetNeedsNoRestore() {
        Map<String, Integer> afterReset = new LinkedHashMap<>();
        afterReset.put(PRIMARY_ALIAS, PackageManager.COMPONENT_ENABLED_STATE_DEFAULT);
        afterReset.put(GRUMPY_GREEN_ALIAS, PackageManager.COMPONENT_ENABLED_STATE_DISABLED);
        afterReset.put(GOOFY_TEAL_ALIAS, PackageManager.COMPONENT_ENABLED_STATE_DISABLED);

        Map<String, Integer> afterAlternate = new LinkedHashMap<>();
        afterAlternate.put(PRIMARY_ALIAS, PackageManager.COMPONENT_ENABLED_STATE_DISABLED);
        afterAlternate.put(GRUMPY_GREEN_ALIAS, PackageManager.COMPONENT_ENABLED_STATE_DISABLED);
        afterAlternate.put(GOOFY_TEAL_ALIAS, PackageManager.COMPONENT_ENABLED_STATE_ENABLED);

        assertFalse(AppIconPlugin.restoresPrimaryAlias(afterReset));
        assertFalse(AppIconPlugin.restoresPrimaryAlias(afterAlternate));
    }

    @Test
    public void restoresNothingWhenTheBuildDeclaresNoPrimaryAlias() {
        assertFalse(AppIconPlugin.restoresPrimaryAlias(Collections.emptyMap()));
    }

    /**
     * The launcher icon is swapped by toggling aliases only. Toggling the
     * activity itself would take the deep links, shortcuts, voice notification,
     * and Quick Settings tile down with it, so the plugin's code never names it.
     */
    @Test
    public void neverTogglesTheActivityBehindTheAliases() throws IOException {
        String code = stripComments(readPluginSource());

        assertTrue(code.contains("setComponentEnabledSetting"));
        assertFalse(code.contains("MainActivity"));
    }

    private static String readPluginSource() throws IOException {
        for (String candidate : SOURCE_PATHS) {
            Path path = Paths.get(candidate);
            if (Files.exists(path)) {
                return new String(Files.readAllBytes(path), StandardCharsets.UTF_8);
            }
        }
        throw new AssertionError(
            "Unable to find AppIconPlugin.java from " + Paths.get("").toAbsolutePath()
        );
    }

    private static String stripComments(String source) {
        return source.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("//[^\\n]*", "");
    }
}
