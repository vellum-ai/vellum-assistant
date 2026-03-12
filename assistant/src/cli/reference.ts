// Keep this snapshot in sync with buildCliProgram().helpInformation() for the
// top-level assistant CLI. It deliberately avoids importing the CLI command
// graph so prompt assembly stays side-effect-free.
export const CLI_HELP_REFERENCE = `Usage: assistant [options] [command]

Local AI assistant

Options:
  -V, --version                            output the version number
  -h, --help                               display help for command

Commands:
  sessions                                 Manage sessions
  config                                   Manage configuration
  keys                                     Manage API keys in secure storage
  credentials [options]                    Manage credentials in the encrypted vault (API keys, tokens, passwords)
  trust                                    Manage trust rules
  memory                                   Manage long-term memory indexing/retrieval
  audit [options]                          Show recent tool invocations
  doctor                                   Run diagnostic checks
  hooks                                    Manage hooks
  mcp                                      Manage MCP (Model Context Protocol) servers
  email [options]                          Email operations (provider-agnostic)
  contacts [options]                       Manage and query the contact graph
  channel-verification-sessions [options]  Manage channel verification sessions
  autonomy [options]                       View and configure autonomy tiers
  completions <shell>                      Generate shell completion script (e.g. assistant completions bash >> ~/.bashrc)
  notifications [options]                  Send and inspect notifications through the unified notification router
  platform [options]                       Manage platform integration for containerized deployments
  oauth [options]                          Manage OAuth providers, apps, connections, and tokens
  skills                                   Browse and install skills from the Vellum catalog
  browser                                  Browser automation, extension relay, and Chrome CDP management
  sequence [options]                       Manage email sequences
`;
