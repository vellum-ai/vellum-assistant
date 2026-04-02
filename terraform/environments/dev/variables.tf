variable "mailgun_api_key" {
  description = "Mailgun API key"
  type        = string
  sensitive   = true
}

variable "smtp_password" {
  description = "SMTP password for the dev domain"
  type        = string
  sensitive   = true
}

variable "inbound_webhook_url" {
  description = "Managed gateway inbound webhook URL for dev"
  type        = string
  default     = "https://platform-dev.vellum.ai/v1/internal/managed-gateway/email/inbound/"
}
