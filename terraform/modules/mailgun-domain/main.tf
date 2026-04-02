# -----------------------------------------------------------------------------
# Mailgun Domain
# Registers the domain with Mailgun and configures sending/receiving.
# DNS records (MX, SPF, DKIM) are output for manual configuration in your
# DNS provider — this module does NOT manage DNS directly.
# -----------------------------------------------------------------------------

resource "mailgun_domain" "this" {
  name                 = var.domain
  region               = var.region
  spam_action          = var.spam_action
  dkim_key_size        = var.dkim_key_size
  force_dkim_authority = var.force_dkim_authority
  smtp_password        = var.smtp_password

  # Disable tracking — assistant emails should not have tracking pixels
  open_tracking  = "no"
  click_tracking = "no"
  web_scheme     = "https"
}

# -----------------------------------------------------------------------------
# Catch-All Inbound Route
# Forwards all mail to *@<domain> to the managed gateway webhook endpoint.
# Routing to the correct assistant happens in our code, not in Mailgun.
# -----------------------------------------------------------------------------

resource "mailgun_route" "catch_all" {
  priority    = var.catch_all_route_priority
  description = "Catch-all inbound route for ${var.domain}"
  expression  = "match_recipient('.*@${var.domain}')"

  actions = [
    "forward('${var.inbound_webhook_url}')",
    "stop()",
  ]

  region = var.region
}

# -----------------------------------------------------------------------------
# Event Webhooks (optional)
# Configure Mailgun to POST delivery events to our webhook endpoint.
# Used for bounce handling, delivery confirmation, spam complaints.
# -----------------------------------------------------------------------------

resource "mailgun_webhook" "events" {
  for_each = var.webhook_urls

  domain = mailgun_domain.this.name
  region = var.region
  kind   = each.key
  urls   = each.value
}
