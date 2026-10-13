group "default" {
  targets = ["combined"]
}

target "assistant" {
  context = "."
  dockerfile = "assistant/Dockerfile"
  platforms = ["linux/amd64"]
}

target "combined" {
  context = "."
  dockerfile = "docker/combined/Dockerfile"
  contexts = { assistant-base = "target:assistant" }
  platforms = ["linux/amd64"]
  tags = ["vellum-combined:local"]
}

target "blaxel" {
  context = "."
  dockerfile = "docker/combined/Dockerfile.blaxel"
  contexts = { combined-base = "target:combined" }
  platforms = ["linux/amd64"]
  tags = ["vellum-combined-blaxel:local"]
}
