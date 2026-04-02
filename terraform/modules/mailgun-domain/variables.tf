variable "domain" {
  description = "The email domain to register with Mailgun (e.g. dev.vellum.me)"
  type        = string
}

variable "region" {
  description = "Mailgun region: us or eu"
  type        = string
  default     = "us"

  validation {
    condition     = contains(["us", "eu"], var.region)
    error_message = "Region must be 'us' or 'eu'."
  }
}

variable "spam_action" {
  description = "Spam filtering action: disabled or tag"
  type        = string
  default     = "tag"

  validation {
    condition     = contains(["disabled", "tag"], var.spam_action)
    error_message = "spam_action must be 'disabled' or 'tag'."
  }
}

variable "dkim_key_size" {
  description = "DKIM key size in bits"
  type        = number
  default     = 2048
}

variable "force_dkim_authority" {
  description = "Force DKIM authority for this domain even if root domain is on the same Mailgun account"
  type        = bool
  default     = true
}

variable "inbound_webhook_url" {
  description = "URL where Mailgun forwards inbound email (managed gateway endpoint)"
  type        = string
}

variable "catch_all_route_priority" {
  description = "Priority for the catch-all inbound route (lower = higher priority)"
  type        = number
  default     = 0
}

variable "webhook_urls" {
  description = "Map of Mailgun event webhook kinds to their handler URLs. Supported kinds: delivered, permanent_fail, temporary_fail, complained, opened, clicked, unsubscribed"
  type        = map(list(string))
  default     = {}
}

variable "smtp_password" {
  description = "SMTP password for the domain (sensitive)"
  type        = string
  sensitive   = true
}
