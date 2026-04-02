output "domain_name" {
  description = "The registered Mailgun domain name"
  value       = mailgun_domain.this.name
}

output "smtp_login" {
  description = "SMTP login for the domain"
  value       = mailgun_domain.this.smtp_login
}

output "receiving_records" {
  description = "DNS records required for receiving email (MX records). Configure these in your DNS provider."
  value       = mailgun_domain.this.receiving_records_set
}

output "sending_records" {
  description = "DNS records required for sending email (SPF, DKIM). Configure these in your DNS provider."
  value       = mailgun_domain.this.sending_records_set
}

output "catch_all_route_id" {
  description = "ID of the catch-all inbound route"
  value       = mailgun_route.catch_all.id
}

output "dns_records_summary" {
  description = "Human-readable summary of DNS records to configure"
  value       = <<-EOT
    ============================================================
    DNS RECORDS TO CONFIGURE FOR ${mailgun_domain.this.name}
    ============================================================

    After applying, configure these DNS records in your provider:

    RECEIVING (MX) RECORDS:
    %{for r in mailgun_domain.this.receiving_records_set~}
      ${r.record_type}  ${r.name}  ${r.value}  (priority: ${r.priority})
    %{endfor~}

    SENDING (SPF/DKIM) RECORDS:
    %{for r in mailgun_domain.this.sending_records_set~}
      ${r.record_type}  ${r.name}  ${r.value}
    %{endfor~}

    DMARC (configure manually):
      TXT  _dmarc.${mailgun_domain.this.name}  "v=DMARC1; p=none; rua=mailto:dmarc-reports@vellum.ai; adkim=s; aspf=s; pct=100"

    NOTE: Start with DMARC p=none for monitoring. Graduate to
    p=quarantine then p=reject after verifying alignment.
    ============================================================
  EOT
}
