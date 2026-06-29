package ai.vocify.vellumassistant;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeAuthPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
