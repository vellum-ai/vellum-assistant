locals {
  app_image = coalesce(var.app_image, "gcr.io/${var.project_id}/vellum-assistant:latest")
}

# Kubernetes Namespace
resource "kubernetes_namespace" "vellum_assistant" {
  metadata {
    name = "vellum-assistant"

    labels = {
      app = "vellum-assistant"
      env = var.environment
    }
  }
}

# ConfigMap for non-sensitive config
resource "kubernetes_config_map" "app_config" {
  metadata {
    name      = "vellum-assistant-config"
    namespace = kubernetes_namespace.vellum_assistant.metadata[0].name
  }

  data = {
    NODE_ENV                           = "production"
    BETTER_AUTH_URL                    = "https://${var.domain}"
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = var.stripe_publishable_key
  }
}

# Secret for sensitive values
resource "kubernetes_secret" "app_secrets" {
  metadata {
    name      = "vellum-assistant-secrets"
    namespace = kubernetes_namespace.vellum_assistant.metadata[0].name
  }

  data = {
    DATABASE_URL       = local.database_url
    ANTHROPIC_API_KEY  = var.anthropic_api_key
    BETTER_AUTH_SECRET = random_password.better_auth_secret.result
    STRIPE_SECRET_KEY  = var.stripe_secret_key
  }

  type = "Opaque"
}

# Deployment
resource "kubernetes_deployment" "app" {
  metadata {
    name      = "vellum-assistant"
    namespace = kubernetes_namespace.vellum_assistant.metadata[0].name

    labels = {
      app = "vellum-assistant"
    }
  }

  spec {
    replicas = var.app_replicas

    selector {
      match_labels = {
        app = "vellum-assistant"
      }
    }

    template {
      metadata {
        labels = {
          app = "vellum-assistant"
        }
      }

      spec {
        container {
          name  = "web"
          image = local.app_image

          port {
            container_port = 3000
          }

          env_from {
            config_map_ref {
              name = kubernetes_config_map.app_config.metadata[0].name
            }
          }

          env_from {
            secret_ref {
              name = kubernetes_secret.app_secrets.metadata[0].name
            }
          }

          resources {
            requests = {
              cpu    = "100m"
              memory = "256Mi"
            }
            limits = {
              cpu    = "500m"
              memory = "512Mi"
            }
          }

          liveness_probe {
            http_get {
              path = "/api/health"
              port = 3000
            }
            initial_delay_seconds = 30
            period_seconds        = 10
          }

          readiness_probe {
            http_get {
              path = "/api/health"
              port = 3000
            }
            initial_delay_seconds = 5
            period_seconds        = 5
          }
        }
      }
    }
  }
}

# Service
resource "kubernetes_service" "app" {
  metadata {
    name      = "vellum-assistant"
    namespace = kubernetes_namespace.vellum_assistant.metadata[0].name

    annotations = {
      "cloud.google.com/neg" = jsonencode({
        ingress = true
      })
    }
  }

  spec {
    selector = {
      app = "vellum-assistant"
    }

    port {
      port        = 80
      target_port = 3000
    }

    type = "ClusterIP"
  }
}

# Static IP for Ingress
resource "google_compute_global_address" "ingress_ip" {
  name = "vellum-assistant-ip"

  depends_on = [google_project_service.compute]
}

# Managed SSL Certificate
resource "google_compute_managed_ssl_certificate" "default" {
  name = "vellum-assistant-cert"

  depends_on = [google_project_service.compute]

  managed {
    domains = [var.domain]
  }
}

# Ingress with Google-managed SSL
resource "kubernetes_ingress_v1" "app" {
  metadata {
    name      = "vellum-assistant"
    namespace = kubernetes_namespace.vellum_assistant.metadata[0].name

    annotations = {
      "kubernetes.io/ingress.class"                 = "gce"
      "kubernetes.io/ingress.global-static-ip-name" = google_compute_global_address.ingress_ip.name
      "ingress.gcp.kubernetes.io/pre-shared-cert"   = google_compute_managed_ssl_certificate.default.name
      "kubernetes.io/ingress.allow-http"            = "true"
    }
  }

  spec {
    rule {
      host = var.domain

      http {
        path {
          path      = "/*"
          path_type = "ImplementationSpecific"

          backend {
            service {
              name = kubernetes_service.app.metadata[0].name
              port {
                number = 80
              }
            }
          }
        }
      }
    }
  }
}
