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
  CONVERSATION_ERROR_PROVIDER_CONTENT_FILTERED:
    "conversation.error.provider_content_filtered",
  PLUGIN_MCP_OAUTH_CREDENTIALS_UNCHECKED:
    "plugin.uninstall.mcp_oauth_credentials_unchecked",
} as const;

export type MessageKey = (typeof MESSAGE_KEYS)[keyof typeof MESSAGE_KEYS];

export const MESSAGE_CATALOGS: Record<
  SupportedLocale,
  Record<MessageKey, string>
> = {
  en: {
    "conversation.title.generating": "Generating title...",
    "conversation.title.untitled": "Untitled Conversation",
    "conversation.error.provider_content_filtered":
      "The model provider's content filter blocked this request. Something in the conversation (your message, an attachment, or a tool result) tripped its safety rules. This isn't a bug and retrying won't help: rephrase or remove that content, start a new conversation, or switch to a different model.",
    "plugin.uninstall.mcp_oauth_credentials_unchecked":
      "Credential storage is unavailable, so historical plugin MCP OAuth credentials could not be checked.",
  },
  es: {
    "conversation.title.generating": "Generando título...",
    "conversation.title.untitled": "Sin título",
    "conversation.error.provider_content_filtered":
      "El filtro de contenido del proveedor del modelo bloqueó esta solicitud. Algo en la conversación (tu mensaje, un archivo adjunto o el resultado de una herramienta) activó sus reglas de seguridad. No es un error y reintentar no servirá: reformula o elimina ese contenido, inicia una conversación nueva o cambia a otro modelo.",
    "plugin.uninstall.mcp_oauth_credentials_unchecked":
      "El almacenamiento de credenciales no está disponible, por lo que no se pudieron comprobar las credenciales históricas de OAuth de MCP del plugin.",
  },
  ru: {
    "conversation.title.generating": "Создание названия...",
    "conversation.title.untitled": "Без названия",
    "conversation.error.provider_content_filtered":
      "Фильтр контента поставщика модели заблокировал этот запрос. Что-то в разговоре (ваше сообщение, вложение или результат инструмента) нарушило его правила безопасности. Это не ошибка, и повторная попытка не поможет: переформулируйте или удалите этот контент, начните новый разговор или переключитесь на другую модель.",
    "plugin.uninstall.mcp_oauth_credentials_unchecked":
      "Хранилище учетных данных недоступно, поэтому не удалось проверить сохраненные учетные данные OAuth MCP плагина.",
  },
  zh: {
    "conversation.title.generating": "标题生成中...",
    "conversation.title.untitled": "无标题",
    "conversation.error.provider_content_filtered":
      "模型提供商的内容过滤器拦截了此请求。对话中的某些内容（你的消息、附件或工具结果）触发了其安全规则。这不是程序错误，重试也无济于事：请改写或删除相关内容、开始新的对话，或切换到其他模型。",
    "plugin.uninstall.mcp_oauth_credentials_unchecked":
      "凭据存储不可用，因此无法检查该插件之前的 MCP OAuth 凭据。",
  },
  "zh-TW": {
    "conversation.title.generating": "標題產生中...",
    "conversation.title.untitled": "未命名",
    "conversation.error.provider_content_filtered":
      "模型供應商的內容篩選器封鎖了這個請求。對話中的某些內容（你的訊息、附件或工具結果）觸發了其安全規則。這不是程式錯誤，重試也沒有幫助：請改寫或移除該內容、開始新的對話，或切換到其他模型。",
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
