# Headless-Chromium driver image for jailed app interaction.
#
# The base image bakes the browser binaries and a matching Node runtime
# under `/ms-playwright`, but NOT the `playwright` npm package — so the
# image installs `playwright@1.61.0` (the version whose browsers the base
# ships) and points it at the pre-baked browsers via
# `PLAYWRIGHT_BROWSERS_PATH`, avoiding a second browser download at build
# or run time.
#
# `server.mjs` runs as the container's main process: it launches Chromium
# with a CDP endpoint and keeps it alive for the session. Each interaction
# is a short-lived `driver.mjs` invoked over `docker exec`, attaching to
# the same browser over CDP so page state persists across actions. The
# image is built locally on demand by `BrowserSession` and never pushed,
# mirroring the recording egress jail's owner-mode build.
FROM mcr.microsoft.com/playwright:v1.61.0-noble@sha256:d0db7b8fc460af57a7dafb193d8cea52de84d7c2e6eb1e1cf49b974e96a42995

WORKDIR /opt/browser

# `npm init` materialises a package.json inside the image layer so the
# install pins exactly; the build context deliberately ships no
# package.json, keeping the harness's dependency surface (and the tools
# that scan it) limited to the TypeScript project.
RUN npm init -y >/dev/null 2>&1 \
  && npm install --no-audit --no-fund --save-exact playwright@1.61.0

COPY server.mjs driver.mjs ./

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

CMD ["node", "server.mjs"]
