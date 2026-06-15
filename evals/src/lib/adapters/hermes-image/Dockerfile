# Derived Hermes image for jailed eval runs.
#
# Layers the lazy-installed native Anthropic SDK into the upstream Hermes
# image at build time, so a Hermes container born inside the fail-closed
# egress jail never has to reach PyPI at request time.
#
# Hermes ships some provider backends without their Python deps and
# `uv pip install`s them in-venv the first time a feature is used
# (`/opt/hermes/tools/lazy_deps.py`). The native Anthropic SDK is one such
# lazy dep. Under the recording jail (default-DROP egress, only model +
# platform hosts allowlisted) that first-use install hangs on dropped PyPI
# traffic until the turn exhausts its retry budget. Resolving the dep here
# — while the Docker build still has open egress — bakes it into the
# hermes-owned venv so the runtime is dependency-complete behind the jail.
#
# The base tag is passed as a build arg so the pin stays single-sourced in
# the adapter (`DEFAULT_HERMES_IMAGE`); the build is content-cached and only
# re-runs when the base tag or this file changes.
ARG HERMES_BASE
FROM ${HERMES_BASE}

# Resolve the dep as the unprivileged `hermes` user the gateway runs turns
# as, so the installed files are owned by the importer (a root-owned venv
# entry would block hermes-user writes). `HERMES_DISABLE_LAZY_INSTALLS=0`
# overrides the runtime lock so this one build-time install is permitted.
USER hermes
RUN HERMES_DISABLE_LAZY_INSTALLS=0 PYTHONPATH=/opt/hermes \
  /opt/hermes/.venv/bin/python3 -c \
  "from tools.lazy_deps import ensure; ensure('provider.anthropic')"
USER root
