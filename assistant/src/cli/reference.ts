// Keep this snapshot in sync with buildCliProgram().helpInformation() for the
// top-level assistant CLI. It deliberately avoids importing the CLI command
// graph so prompt assembly stays side-effect-free.
export const CLI_HELP_REFERENCE = `Usage: assistant [options] [command]

Local AI assistant

Options:
  -V, --version            output the version number
  -h, --help               display help for command

Commands:
  dev [options]            Run the assistant in dev mode
  sessions                 Manage sessions
  config                   Manage configuration
  keys                     Manage API keys in secure storage
  credentials [options]    Manage credentials in the encrypted vault (API keys,
                           tokens, passwords)
  trust                    Manage trust rules
  memory                   Manage long-term memory indexing/retrieval
  audit [options]          Show recent tool invocations
  doctor                   Run diagnostic checks
  hooks                    Manage hooks
  mcp                      Manage MCP (Model Context Protocol) servers
  email [options]          Email operations (provider-agnostic)
  integrations [options]   Read integration configuration and readiness status
  contacts [options]       Manage and query the contact graph
  channels [options]       Query channel status
  channel-verification-sessions [options]
                           Manage channel verification sessions
  amazon [options]         Shop on Amazon and Amazon Fresh. Requires a session
                           imported from a Ride Shotgun recording.
  autonomy [options]       View and configure autonomy tiers
  completions <shell>      Generate shell completion script (e.g. vellum
                           completions bash >> ~/.bashrc)
  notifications [options]  Send and inspect notifications through the unified
                           notification router
  oauth [options]          Manage OAuth tokens for connected integrations
  platform [options]       Manage platform integration for containerized
                           deployments
  skills                   Browse and install skills from the Vellum catalog
  x|twitter [options]      Post on X and manage connections. Supports OAuth
                           (official API) and browser session paths.
  map [options] <domain>   Auto-navigate a domain and produce a deduplicated API
                           map. Launches Chrome with CDP, starts a Ride Shotgun
                           learn session, then analyzes captured network
                           traffic.
  influencer [options]     Research influencers on Instagram, TikTok, and
                           X/Twitter. Uses the Chrome extension relay to browse
                           each platform. Requires the user to be logged in on
                           each platform in Chrome.
  sequence [options]       Manage email sequences
`;
