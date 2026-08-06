import type { OAuthConnectSurfaceData } from "../../../api/surfaces.js";

export interface OAuthConnectSurfaceNextAction {
  type: "ui_show";
  surfaceType: "oauth_connect";
  data: Pick<OAuthConnectSurfaceData, "providerKey" | "requestedScopes">;
}

export interface OAuthConnectSurfaceRedirect {
  ok: false;
  code: "use_oauth_connect_surface";
  provider: string;
  hint: string;
  nextAction: OAuthConnectSurfaceNextAction;
}

export function oauthConnectSurfaceHint(
  provider: string,
  requestedScopes?: string[],
): string {
  const base =
    `To let the user connect, render the connect button: call ` +
    `\`ui_show\` with surface_type "oauth_connect" and ` +
    `data.providerKey "${provider}". That surface is always available — do ` +
    `not run further \`oauth\`/\`channels\` commands, paste an OAuth URL, or ` +
    `load a setup skill just to display it.`;
  if (!requestedScopes?.length) {
    return base;
  }
  return (
    base +
    ` Include data.requestedScopes verbatim from nextAction.data in the ` +
    `\`ui_show\` call: it is a full replacement set, so list every default ` +
    `scope you want to keep, not just the new ones.`
  );
}

export function buildOAuthConnectSurfaceNextAction(
  provider: string,
  requestedScopes?: string[],
): OAuthConnectSurfaceNextAction {
  return {
    type: "ui_show",
    surfaceType: "oauth_connect",
    data: {
      providerKey: provider,
      ...(requestedScopes?.length ? { requestedScopes } : {}),
    },
  };
}

export function buildOAuthConnectSurfaceRedirect(
  provider: string,
  requestedScopes?: string[],
): OAuthConnectSurfaceRedirect {
  return {
    ok: false,
    code: "use_oauth_connect_surface",
    provider,
    hint: oauthConnectSurfaceHint(provider, requestedScopes),
    nextAction: buildOAuthConnectSurfaceNextAction(provider, requestedScopes),
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
