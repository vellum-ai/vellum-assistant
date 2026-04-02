terraform {
  required_version = ">= 1.5.0"

  required_providers {
    mailgun = {
      source  = "wgebis/mailgun"
      version = "~> 0.9.0"
    }
  }

  # TODO: Configure remote backend (e.g. GCS, S3) before production use.
  # For dev, local state is acceptable but should not be committed.
  # backend "gcs" {
  #   bucket = "vellum-terraform-state"
  #   prefix = "mailgun/dev"
  # }
}

provider "mailgun" {
  api_key = var.mailgun_api_key
}
