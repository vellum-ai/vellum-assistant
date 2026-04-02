# Terraform — Email Infrastructure (Mailgun)

This directory contains Terraform configuration for Vellum Assistant's email
channel infrastructure, powered by [Mailgun](https://www.mailgun.com/).

## Structure

```
terraform/
├── modules/
│   └── mailgun-domain/        # Reusable module: domain + route + webhooks
│       ├── main.tf
│       ├── variables.tf
│       ├── outputs.tf
│       └── versions.tf
├── environments/
│   └── dev/                   # Dev environment (dev.vellum.me)
│       ├── main.tf
│       ├── variables.tf
│       ├── outputs.tf
│       ├── versions.tf
│       └── terraform.tfvars.example
└── README.md
```

## Quick Start (Dev)

### Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.5.0
- A Mailgun account with API key
- DNS access for `dev.vellum.me`

### Setup

```bash
cd terraform/environments/dev

# Copy and fill in secrets
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with real values

# Initialize
terraform init

# Preview changes
terraform plan

# Apply
terraform apply
```

### After Apply

Terraform will output the DNS records you need to configure. Add these to
your DNS provider for `dev.vellum.me`:

1. **MX records** — Point to Mailgun's inbound servers
2. **SPF record** — TXT record authorizing Mailgun to send
3. **DKIM record** — TXT record with the domain's public signing key
4. **DMARC record** — TXT record (start with `p=none` for monitoring)

After DNS records propagate, verify the domain in Mailgun:

```bash
# Trigger verification via Mailgun API
curl -s --user "api:$MAILGUN_API_KEY" \
  -X PUT "https://api.mailgun.net/v3/domains/dev.vellum.me/verify"
```

## Environments

| Environment | Domain | Status |
|---|---|---|
| dev | `dev.vellum.me` | PR 1 (this PR) |
| production | `vellum.me` | Deferred until dev tracer bullet validated |

## Module: `mailgun-domain`

Reusable module that provisions:

- **Mailgun domain** with DKIM, SPF, spam filtering
- **Catch-all inbound route** forwarding `*@domain` to the managed gateway
- **Event webhooks** (optional) for delivery tracking and bounce handling

### Inputs

| Variable | Description | Required |
|---|---|---|
| `domain` | Email domain (e.g. `dev.vellum.me`) | Yes |
| `smtp_password` | SMTP password for the domain | Yes |
| `inbound_webhook_url` | URL for Mailgun to POST inbound email | Yes |
| `region` | Mailgun region (`us` or `eu`) | No (default: `us`) |
| `spam_action` | Spam filter action (`disabled` or `tag`) | No (default: `tag`) |
| `dkim_key_size` | DKIM key size in bits | No (default: `2048`) |
| `force_dkim_authority` | Force DKIM authority for subdomain | No (default: `true`) |
| `catch_all_route_priority` | Route priority (lower = higher) | No (default: `0`) |
| `webhook_urls` | Map of event kind → handler URLs | No (default: `{}`) |

### Outputs

| Output | Description |
|---|---|
| `domain_name` | The registered domain |
| `smtp_login` | SMTP login credential |
| `receiving_records` | MX records to configure in DNS |
| `sending_records` | SPF/DKIM records to configure in DNS |
| `dns_records_summary` | Human-readable DNS setup instructions |
| `catch_all_route_id` | Mailgun route ID |

## Security Notes

- **Never commit `terraform.tfvars`** — it contains the Mailgun API key and SMTP password
- **State files contain secrets** — use a remote backend with encryption for production
- The `.gitignore` at repo root should exclude `*.tfstate`, `*.tfstate.backup`, and `*.tfvars`
