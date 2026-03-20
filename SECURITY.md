# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Vellum Assistant, please report it responsibly. **Do not open a public GitHub issue.**

Email **security@vellum.ai** with:
- A description of the vulnerability
- Steps to reproduce
- The potential impact
- Any suggested fix (optional)

We will acknowledge receipt within 48 hours and aim to provide a resolution timeline within 5 business days.

## Scope

This policy covers the code in this repository, including:
- The assistant runtime (`assistant/`)
- The gateway (`gateway/`)
- The CLI (`cli/`)
- Native clients (`clients/`)
- The credential execution service (`credential-executor/`)

## Security Model

For details on Vellum Assistant's security architecture — including sandboxing, credential storage, permission modes, and trust rules — see the [Security Architecture documentation](assistant/docs/architecture/security.md).
