/**
 * The URL fixtures the route-parser suites share: `routes.test.ts`, which pins
 * the value the parser returns, and `routes-params-parity.test.tsx`, which pins
 * that value against the one the real router hands `useParams`. Each spelling
 * lives here once, so the two suites cannot drift onto different URLs and read
 * the result as agreement.
 */

/**
 * A truncated percent sequence. `decodeURIComponent` throws on it, and our
 * producers write ids unencoded, so a literal `%` in an id reaches the parser
 * this way and leaves every segment of the path raw.
 */
export const MALFORMED_ESCAPE = "%E0%A4%A";

export const ESCAPED_CONVERSATIONS_PREFIX = "/assistant/%63onversations";

/**
 * A plugin app id carrying a space, which reaches the URL encoded because a
 * plugin app takes its id from the author's directory name.
 */
export const ENCODED_APP_ID = "plugins~p~My App";

export const ENCODED_APP_PATH = `/assistant/conversations/c1/app/${encodeURIComponent(ENCODED_APP_ID)}`;

export const MALFORMED_CONVERSATION_PATH = `/assistant/conversations/${MALFORMED_ESCAPE}`;

export const MALFORMED_CONVERSATION_WITH_APP_PATH = `/assistant/conversations/${MALFORMED_ESCAPE}/app/My%20App`;

export const MALFORMED_APP_PATH = `/assistant/conversations/conv%20x/app/${MALFORMED_ESCAPE}`;

export const ENCODED_SLASH_APP_PATH = "/assistant/conversations/c1/app/a%2Fb";

export const RAW_ENCODED_SLASH_APP_PATH = `/assistant/conversations/${MALFORMED_ESCAPE}/app/a%2Fb`;

/** An app route whose prefix is spelled escaped, which the router matches. */
export const ESCAPED_PREFIX_APP_PATH = `${ESCAPED_CONVERSATIONS_PREFIX}/c1/app/app-1`;
