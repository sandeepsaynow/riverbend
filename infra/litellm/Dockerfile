# Riverbend LiteLLM proxy image for Cloud Run (D26 deploy fix).
#
# The stock berriai/litellm image has NO model_list, so the `riverbend-extraction` alias (→
# openai/gpt-5.4-mini-2026-03-17) and the per-shop budgets never load and every extraction call fails.
# Locally this is solved by a compose bind-mount of litellm/config.yaml; Cloud Run has no bind mount, so we
# bake the config into a digest-pinned image and point var.litellm_image at it.
#
# The provider key + master key are NOT baked here — they arrive as env from Secret Manager (the config
# references os.environ/OPENAI_API_KEY and os.environ/LITELLM_MASTER_KEY), so this image holds no secrets.
#
# Build + push (digest-pinned), then set var.litellm_image to the @sha256 digest:
#   gcloud auth configure-docker <region>-docker.pkg.dev
#   docker build -f infra/litellm/Dockerfile -t <region>-docker.pkg.dev/<project>/riverbend/litellm:<sha> .
#   docker push <region>-docker.pkg.dev/<project>/riverbend/litellm:<sha>
#   docker inspect --format='{{index .RepoDigests 0}}' <...>/litellm:<sha>   # → the @sha256 for tfvars

# Pin to the same digest used in docker-compose.yml (keep the two in sync).
FROM ghcr.io/berriai/litellm:main-stable@sha256:37e2dafb088a7723beb998590682957386dfc83ffea1848486f8e0e5cfac0b06

# Bake the model routing + budget config. Build context is the repo root.
COPY litellm/config.yaml /app/config.yaml

# Cloud Run injects PORT; litellm listens on 4000 (matches the Terraform container_port + compose).
CMD ["--config", "/app/config.yaml", "--port", "4000", "--num_workers", "1"]
