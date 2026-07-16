export interface OAuthConnectSurfaceNextAction {
  type: "ui_show";
  surfaceType: "oauth_connect";
  data: { providerKey: string };
}

export interface OAuthConnectSurfaceRedirect {
  ok: false;
  code: "use_oauth_connect_surface";
  provider: string;
  hint: string;
  nextAction: OAuthConnectSurfaceNextAction;
}

export function oauthConnectSurfaceHint(provider: string): string {
  return (
    `To let the user connect, render the connect button: call ` +
    `\`ui_show\` with surface_type "oauth_connect" and ` +
    `data.providerKey "${provider}". That surface is always available — do ` +
    `not run further \`oauth\`/\`channels\` commands, paste an OAuth URL, or ` +
    `load a setup skill just to display it.`
  );
}

export function buildOAuthConnectSurfaceNextAction(
  provider: string,
): OAuthConnectSurfaceNextAction {
  return {
    type: "ui_show",
    surfaceType: "oauth_connect",
    data: { providerKey: provider },
  };
}

export function buildOAuthConnectSurfaceRedirect(
  provider: string,
): OAuthConnectSurfaceRedirect {
  return {
    ok: false,
    code: "use_oauth_connect_surface",
    provider,
    hint: oauthConnectSurfaceHint(provider),
    nextAction: buildOAuthConnectSurfaceNextAction(provider),
  };
}

export function isModelSpawnedConversationShell(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    typeof env.__CONVERSATION_ID === "string" &&
    env.__CONVERSATION_ID.trim().length > 0
  );
}
