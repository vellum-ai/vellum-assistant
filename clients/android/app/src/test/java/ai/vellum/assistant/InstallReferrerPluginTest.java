package ai.vellum.assistant;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.android.installreferrer.api.InstallReferrerClient.InstallReferrerResponse;
import org.junit.Test;

public class InstallReferrerPluginTest {
    @Test
    public void unsupportedPlayStoresAreTerminal() {
        assertTrue(InstallReferrerPlugin.isTerminalStatus(InstallReferrerResponse.FEATURE_NOT_SUPPORTED));
        assertTrue(InstallReferrerPlugin.isTerminalStatus(InstallReferrerResponse.DEVELOPER_ERROR));
    }

    @Test
    public void unavailableAndDisconnectedServicesAreRetryable() {
        assertFalse(InstallReferrerPlugin.isTerminalStatus(InstallReferrerResponse.SERVICE_UNAVAILABLE));
        assertFalse(InstallReferrerPlugin.isTerminalStatus(InstallReferrerResponse.SERVICE_DISCONNECTED));
    }

    @Test
    public void successIsNotTerminal() {
        assertFalse(InstallReferrerPlugin.isTerminalStatus(InstallReferrerResponse.OK));
    }
}
