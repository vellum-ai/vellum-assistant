terraform {
  required_version = ">= 1.5.0"

  required_providers {
    mailgun = {
      source  = "wgebis/mailgun"
      version = "~> 0.9.0"
    }
  }
}
