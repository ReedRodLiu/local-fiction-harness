package io.localfiction.harness;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeSsePlugin.class);
        registerPlugin(NativeBinaryPlugin.class);
        registerPlugin(NativeVaultPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
