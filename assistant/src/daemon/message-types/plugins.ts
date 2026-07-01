// Plugin management types.

// === Server → Client ===

export interface PluginStateChanged {
  type: "plugins_state_changed";
  name: string;
  state: "enabled" | "disabled";
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _PluginsServerMessages = PluginStateChanged;
