output "domain_name" {
  description = "The registered dev domain"
  value       = module.mailgun_domain.domain_name
}

output "smtp_login" {
  description = "SMTP login for dev domain"
  value       = module.mailgun_domain.smtp_login
}

output "receiving_records" {
  description = "MX records to configure in DNS"
  value       = module.mailgun_domain.receiving_records
}

output "sending_records" {
  description = "SPF/DKIM records to configure in DNS"
  value       = module.mailgun_domain.sending_records
}

output "dns_records_summary" {
  description = "Human-readable DNS setup instructions"
  value       = module.mailgun_domain.dns_records_summary
}
