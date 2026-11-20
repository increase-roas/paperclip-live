# Builds Paperclip's own `production` target (repo Dockerfile, doc/DOCKER.md)
# and layers docker/increase-roas/Dockerfile on top of it in one bake.
# Used by .github/workflows/ir-image.yml. Local:
#   PAPERCLIP_BUILD_COMMIT=$(git rev-parse HEAD) docker buildx bake -f docker/increase-roas/docker-bake.hcl ir --load

variable "PAPERCLIP_BUILD_COMMIT" { default = "" }
variable "PAPERCLIP_BUILD_VERSION" { default = "" }
variable "CLI_TOOLS_CACHE_EPOCH" { default = "" }
variable "IMAGE" { default = "ghcr.io/increase-roas/paperclip" }
variable "TAGS" { default = "" }

target "production" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "production"
  platforms  = ["linux/amd64"]
  args = {
    PAPERCLIP_BUILD_COMMIT  = PAPERCLIP_BUILD_COMMIT
    PAPERCLIP_BUILD_VERSION = PAPERCLIP_BUILD_VERSION
    CLI_TOOLS_CACHE_EPOCH   = CLI_TOOLS_CACHE_EPOCH
  }
}

target "ir" {
  context    = "."
  dockerfile = "docker/increase-roas/Dockerfile"
  platforms  = ["linux/amd64"]
  contexts = {
    paperclip-base = "target:production"
  }
  tags = TAGS == "" ? ["${IMAGE}:local"] : split(",", TAGS)
  labels = {
    "org.opencontainers.image.source"   = "https://github.com/increase-roas/paperclip"
    "org.opencontainers.image.revision" = PAPERCLIP_BUILD_COMMIT
    "org.opencontainers.image.version"  = PAPERCLIP_BUILD_VERSION
  }
}
