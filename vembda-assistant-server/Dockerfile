FROM python:3.12-slim AS base

RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install --no-install-recommends -y \
    ca-certificates \
    curl && \
    rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

ARG APP_HOME=/server

ENV PYTHONUNBUFFERED=1
ENV PYTHONOPTIMIZE=1
ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy

WORKDIR ${APP_HOME}

RUN addgroup --system app \
    && adduser --system --ingroup app app

FROM base AS build

COPY pyproject.toml uv.lock ./

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev

COPY src/ src/

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

FROM base AS runtime

COPY --from=build ${APP_HOME}/.venv ${APP_HOME}/.venv

ENV PATH="${APP_HOME}/.venv/bin:${PATH}"

COPY --chown=app:app ./deploy/entrypoint /entrypoint
RUN sed -i 's/\r$//g' /entrypoint \
    && chmod +x /entrypoint

COPY --chown=app:app ./deploy/start /start
RUN sed -i 's/\r$//g' /start \
    && chmod +x /start

COPY --chown=app:app src/ ${APP_HOME}/src/

RUN chown app:app ${APP_HOME}

USER app

ENTRYPOINT ["/entrypoint"]

CMD ["/start"]
