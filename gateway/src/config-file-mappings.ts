// This module previously contained CONFIG_FILE_MAPPINGS, applyConfigFileMappings,
// and readConfigFileDefaults that synced config.json fields into GatewayConfig.
// Those are no longer needed — handlers now read dynamic values directly from
// ConfigFileCache and CredentialCache.
