import type { Command } from "commander";

import { resolveService } from "../oauth/provider-profiles.js";
import { getSecureKey } from "../security/secure-keys.js";
import { credentialStoreTool } from "../tools/credentials/vault.js";
import { getCliLogger } from "../util/logger.js";

const log = getCliLogger("cli");

type CredentialPolicyOptions = {
  allowedTool?: string[];
  allowedDomain?: string[];
  usageDescription?: string;
  alias?: string;
};

type CredentialPromptOptions = CredentialPolicyOptions & {
  label?: string;
  description?: string;
  placeholder?: string;
  value?: string;
};

type CredentialOauthOptions = CredentialPolicyOptions & {
  clientId?: string;
  clientSecret?: string;
  authUrl?: string;
  tokenUrl?: string;
  scope?: string[];
  extraParam?: string[];
  userinfoUrl?: string;
  tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post";
};

type CredentialGetOptions = {
  redacted?: boolean;
};

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function buildPolicyInput(
  opts: CredentialPolicyOptions,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (opts.allowedTool && opts.allowedTool.length > 0) {
    input.allowed_tools = opts.allowedTool;
  }
  if (opts.allowedDomain && opts.allowedDomain.length > 0) {
    input.allowed_domains = opts.allowedDomain;
  }
  if (opts.usageDescription) {
    input.usage_description = opts.usageDescription;
  }
  if (opts.alias) {
    input.alias = opts.alias;
  }
  return input;
}

function parseExtraParams(
  extraParamOptions: string[] | undefined,
): Record<string, string> | undefined {
  if (!extraParamOptions || extraParamOptions.length === 0) {
    return undefined;
  }
  const extraParams: Record<string, string> = {};
  for (const pair of extraParamOptions) {
    const idx = pair.indexOf("=");
    if (idx <= 0 || idx === pair.length - 1) {
      throw new Error(
        `Invalid --extra-param "${pair}". Use key=value (for example prompt=consent).`,
      );
    }
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key || !value) {
      throw new Error(
        `Invalid --extra-param "${pair}". Use key=value (for example prompt=consent).`,
      );
    }
    extraParams[key] = value;
  }
  return extraParams;
}

async function runCredentialAction(
  input: Record<string, unknown>,
  contextOverrides: Record<string, unknown> = {},
): Promise<void> {
  const result = await credentialStoreTool.execute(input, {
    workingDir: process.cwd(),
    sessionId: "cli",
    conversationId: "cli",
    trustClass: "guardian",
    ...contextOverrides,
  });
  if (result.isError) {
    log.error(result.content);
    process.exitCode = 1;
    return;
  }

  if (input.action === "list" || input.action === "describe") {
    process.stdout.write(`${result.content}\n`);
    return;
  }

  log.info(result.content);
}

async function readStdinSecret(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data.trim();
}

async function readSecretFromTty(prompt: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    if (!stdin.isTTY) {
      reject(new Error("stdin is not interactive"));
      return;
    }

    const restore = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };

    const onData = (chunk: string | Buffer): void => {
      const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");

      for (const ch of data) {
        if (ch === "\u0003") {
          restore();
          reject(new Error("Credential prompt cancelled by user"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          stdout.write("\n");
          const value = secret;
          restore();
          resolve(value);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (secret.length > 0) {
            secret = secret.slice(0, -1);
          }
          continue;
        }
        secret += ch;
      }
    };

    let secret = "";
    stdout.write(prompt);
    stdin.resume();
    stdin.setRawMode?.(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

async function resolvePromptValue(
  service: string,
  field: string,
  valueArg?: string,
): Promise<string> {
  if (typeof valueArg === "string" && valueArg.length > 0) {
    return valueArg;
  }
  if (!process.stdin.isTTY) {
    return await readStdinSecret();
  }
  return await readSecretFromTty(`Enter secret for ${service}/${field}: `);
}

function redactValue(value: string): string {
  return `[REDACTED length=${value.length}]`;
}

function resolveCredentialGetKeys(
  service: string,
  field: string,
): Array<{ key: string; displayService: string }> {
  const resolvedService = resolveService(service);
  if (resolvedService === service) {
    return [{ key: `credential:${service}:${field}`, displayService: service }];
  }
  return [
    {
      key: `credential:${resolvedService}:${field}`,
      displayService: resolvedService,
    },
    { key: `credential:${service}:${field}`, displayService: service },
  ];
}

export function registerCredentialsCommand(program: Command): void {
  const credentials = program
    .command("credentials")
    .description("Manage secure credentials for services and integrations");

  credentials
    .command("list")
    .description("List stored credentials")
    .alias("ls")
    .action(async () => {
      await runCredentialAction({ action: "list" });
    });

  const registerStoreCommand = (
    commandName: string,
    description: string,
  ): void => {
    credentials
      .command(`${commandName} <service> <field> <value>`)
      .description(description)
      .option(
        "--allowed-tool <tool>",
        "Tool allowed to use this credential (repeat for multiple tools)",
        collectOption,
        [],
      )
      .option(
        "--allowed-domain <domain>",
        "Domain allowed to use this credential (repeat for multiple domains)",
        collectOption,
        [],
      )
      .option(
        "--usage-description <description>",
        "Human-readable purpose for the credential",
      )
      .option("--alias <alias>", "Human-friendly alias for this credential")
      .action(
        async (
          service: string,
          field: string,
          value: string,
          opts: CredentialPolicyOptions,
        ) => {
          await runCredentialAction({
            action: "store",
            service,
            field,
            value,
            ...buildPolicyInput(opts),
          });
        },
      );
  };

  registerStoreCommand("set", "Store a credential value");
  registerStoreCommand("store", 'Alias for "credentials set"');

  credentials
    .command("get <service> <field>")
    .description("Read a stored credential value")
    .option(
      "--redacted",
      "Print redacted metadata instead of the raw secret value",
    )
    .action(
      (service: string, field: string, opts: CredentialGetOptions = {}) => {
        const candidates = resolveCredentialGetKeys(service, field);
        const matched = candidates
          .map((candidate) => ({
            ...candidate,
            value: getSecureKey(candidate.key),
          }))
          .find((candidate) => Boolean(candidate.value));

        const value = matched?.value;
        if (!value) {
          log.error(`Credential not found for ${service}/${field}`);
          process.exitCode = 1;
          return;
        }
        if (matched && matched.displayService !== service) {
          log.info(
            `Resolved ${service}/${field} to ${matched.displayService}/${field}`,
          );
        }
        process.stdout.write(`${opts.redacted ? redactValue(value) : value}\n`);
      },
    );

  credentials
    .command("delete <service> <field>")
    .description("Delete a stored credential")
    .alias("remove")
    .action(async (service: string, field: string) => {
      await runCredentialAction({ action: "delete", service, field });
    });

  credentials
    .command("prompt <service> <field>")
    .description(
      "Prompt for a credential value (reads from hidden TTY input or stdin)",
    )
    .option("--label <label>", "Prompt label shown to the user")
    .option("--description <description>", "Prompt description")
    .option("--placeholder <placeholder>", "Prompt placeholder")
    .option("--value <value>", "Credential value (for non-interactive usage)")
    .option(
      "--allowed-tool <tool>",
      "Tool allowed to use this credential (repeat for multiple tools)",
      collectOption,
      [],
    )
    .option(
      "--allowed-domain <domain>",
      "Domain allowed to use this credential (repeat for multiple domains)",
      collectOption,
      [],
    )
    .option(
      "--usage-description <description>",
      "Human-readable purpose for the credential",
    )
    .action(
      async (
        service: string,
        field: string,
        opts: CredentialPromptOptions = {},
      ) => {
        let value = "";
        try {
          value = await resolvePromptValue(service, field, opts.value);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.toLowerCase().includes("cancel")) {
            log.info("Credential prompt cancelled.");
            process.exitCode = 1;
            return;
          }
          log.error(`Failed to read credential input: ${message}`);
          process.exitCode = 1;
          return;
        }
        if (!value) {
          log.error(
            "No credential value provided. Pass --value, pipe via stdin, or enter a value interactively.",
          );
          process.exitCode = 1;
          return;
        }
        await runCredentialAction(
          {
            action: "prompt",
            service,
            field,
            label: opts.label,
            description: opts.description,
            placeholder: opts.placeholder,
            ...buildPolicyInput(opts),
          },
          {
            requestSecret: async () => ({
              value,
              delivery: "store",
            }),
          },
        );
      },
    );

  credentials
    .command("describe <service>")
    .description("Describe OAuth setup metadata for a service")
    .action(async (service: string) => {
      await runCredentialAction({ action: "describe", service });
    });

  credentials
    .command("oauth2-connect <service>")
    .alias("oauth2_connect")
    .description("Run OAuth2 connect flow for a service")
    .option("--client-id <clientId>", "OAuth client ID")
    .option("--client-secret <clientSecret>", "OAuth client secret")
    .option("--auth-url <url>", "OAuth authorization endpoint")
    .option("--token-url <url>", "OAuth token endpoint")
    .option(
      "--scope <scope>",
      "OAuth scope to request (repeat for multiple scopes)",
      collectOption,
      [],
    )
    .option(
      "--extra-param <key=value>",
      "Additional OAuth authorization query parameter",
      collectOption,
      [],
    )
    .option("--userinfo-url <url>", "OAuth userinfo endpoint")
    .option(
      "--token-endpoint-auth-method <method>",
      "Token endpoint auth method: client_secret_basic or client_secret_post",
    )
    .option(
      "--allowed-tool <tool>",
      "Tool allowed to use resulting credentials (repeat for multiple tools)",
      collectOption,
      [],
    )
    .option(
      "--allowed-domain <domain>",
      "Domain allowed to use resulting credentials (repeat for multiple domains)",
      collectOption,
      [],
    )
    .option(
      "--usage-description <description>",
      "Human-readable purpose for the resulting credentials",
    )
    .action(
      async (
        service: string,
        opts: CredentialOauthOptions = {},
      ): Promise<void> => {
        let extraParams: Record<string, string> | undefined;
        try {
          extraParams = parseExtraParams(opts.extraParam);
        } catch (err) {
          log.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
          return;
        }

        await runCredentialAction(
          {
            action: "oauth2_connect",
            service,
            client_id: opts.clientId,
            client_secret: opts.clientSecret,
            auth_url: opts.authUrl,
            token_url: opts.tokenUrl,
            scopes:
              opts.scope && opts.scope.length > 0 ? opts.scope : undefined,
            extra_params: extraParams,
            userinfo_url: opts.userinfoUrl,
            token_endpoint_auth_method: opts.tokenEndpointAuthMethod,
            ...buildPolicyInput(opts),
          },
          {
            isInteractive: false,
          },
        );
      },
    );
}
