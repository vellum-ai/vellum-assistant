# -----------------------------------------------------------------------------
# Dev Environment — Mailgun Domain Configuration
# Domain: dev.vellum.me
#
# This is the dev tracer bullet for the email channel. Production (vellum.me)
# will be configured in a separate environment after dev is validated.
# -----------------------------------------------------------------------------

module "mailgun_domain" {
  source = "../../modules/mailgun-domain"

  domain               = "dev.vellum.me"
  region               = "us"
  spam_action          = "tag"
  dkim_key_size        = 2048
  force_dkim_authority = true
  smtp_password        = var.smtp_password

  inbound_webhook_url      = var.inbound_webhook_url
  catch_all_route_priority = 0

  # Event webhooks — bounce handling & delivery tracking
  # These will be enabled in PR 6 when the event webhook endpoint exists.
  # Uncomment when the endpoint is deployed:
  # webhook_urls = {
  #   delivered      = ["https://platform-dev.vellum.ai/v1/webhooks/mailgun/events/"]
  #   permanent_fail = ["https://platform-dev.vellum.ai/v1/webhooks/mailgun/events/"]
  #   temporary_fail = ["https://platform-dev.vellum.ai/v1/webhooks/mailgun/events/"]
  #   complained     = ["https://platform-dev.vellum.ai/v1/webhooks/mailgun/events/"]
  # }
}
