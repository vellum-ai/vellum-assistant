/**
 * Daemon message catalog.
 *
 * Keys are the stable identity of a hardcoded constant. English is the
 * source language. Add a key here, then add the same key to every locale
 * catalog. A key present in a translated catalog but missing from English
 * is a test failure.
 *
 * Persist the key when a column holds a system constant. Never persist a
 * translated string, and never treat a stored display string as a key:
 * a user title may be in any language.
 */

import { DEFAULT_LOCALE, type SupportedLocale } from "./locales.js";

export const MESSAGE_KEYS = {
  CONVERSATION_TITLE_GENERATING: "conversation.title.generating",
  CONVERSATION_TITLE_UNTITLED: "conversation.title.untitled",
  AGENT_LOOP_UNPARSEABLE_TOOL_RETRY_STOP: "agentLoop.unparseableToolRetryStop",
  PLUGIN_MCP_OAUTH_CREDENTIALS_UNCHECKED:
    "plugin.uninstall.mcp_oauth_credentials_unchecked",
} as const;

export type MessageKey = (typeof MESSAGE_KEYS)[keyof typeof MESSAGE_KEYS];

export const MESSAGE_CATALOGS: Record<
  SupportedLocale,
  Record<MessageKey, string>
> = {
  en: {
    "agentLoop.unparseableToolRetryStop":
      "I stopped after repeated malformed tool calls to keep this conversation from growing indefinitely. Please try again, or switch models if the problem continues.",
    "conversation.title.generating": "Generating title...",
    "conversation.title.untitled": "Untitled Conversation",
    "plugin.uninstall.mcp_oauth_credentials_unchecked":
      "Credential storage is unavailable, so historical plugin MCP OAuth credentials could not be checked.",
  },
  es: {
    "agentLoop.unparseableToolRetryStop":
      "Me detuve después de varias llamadas de herramienta con formato incorrecto para evitar que esta conversación creciera indefinidamente. Inténtalo de nuevo o cambia de modelo si el problema continúa.",
    "conversation.title.generating": "Generando título...",
    "conversation.title.untitled": "Sin título",
    "plugin.uninstall.mcp_oauth_credentials_unchecked":
      "El almacenamiento de credenciales no está disponible, por lo que no se pudieron comprobar las credenciales históricas de OAuth de MCP del plugin.",
  },
  ru: {
    "agentLoop.unparseableToolRetryStop":
      "Выполнение остановлено после нескольких некорректных вызовов инструментов, чтобы этот разговор не рос бесконечно. Попробуйте ещё раз или смените модель, если проблема не исчезнет.",
    "conversation.title.generating": "Создание названия...",
    "conversation.title.untitled": "Без названия",
    "plugin.uninstall.mcp_oauth_credentials_unchecked":
      "Хранилище учетных данных недоступно, поэтому не удалось проверить сохраненные учетные данные OAuth MCP плагина.",
  },
  zh: {
    "agentLoop.unparseableToolRetryStop":
      "在工具调用多次格式错误后，我已停止运行，以免此对话无限增长。请重试；如果问题仍然存在，请切换模型。",
    "conversation.title.generating": "标题生成中...",
    "conversation.title.untitled": "无标题",
    "plugin.uninstall.mcp_oauth_credentials_unchecked":
      "凭据存储不可用，因此无法检查该插件之前的 MCP OAuth 凭据。",
  },
  "zh-TW": {
    "agentLoop.unparseableToolRetryStop":
      "在工具呼叫多次格式錯誤後，我已停止執行，以免此對話無限增長。請重試；如果問題仍然存在，請切換模型。",
    "conversation.title.generating": "標題產生中...",
    "conversation.title.untitled": "未命名",
    "plugin.uninstall.mcp_oauth_credentials_unchecked":
      "憑證儲存空間無法使用，因此無法檢查此外掛程式先前的 MCP OAuth 憑證。",
  },
};

export function t(
  key: MessageKey,
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  return MESSAGE_CATALOGS[locale][key] ?? MESSAGE_CATALOGS[DEFAULT_LOCALE][key];
}

export function isMessageKey(value: string): value is MessageKey {
  return (Object.values(MESSAGE_KEYS) as string[]).includes(value);
}
