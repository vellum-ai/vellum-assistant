#!/bin/sh
set -e
# Initialize /data directory structure for apt/dpkg when a volume is mounted.
# The Dockerfile configures apt to use /data/dpkg as the admin directory, but
# when /data is a mounted volume the build-time directories are hidden.
# This script ensures the required directories and files exist at startup.

if [ ! -f /data/dpkg/status ]; then
    mkdir -p /data/dpkg/info /data/dpkg/updates /data/dpkg/triggers
    mkdir -p /data/usr/bin /data/usr/lib /data/usr/share
    mkdir -p /data/apt/cache
    touch /data/dpkg/status
    chown -R assistant:assistant /data/dpkg /data/usr /data/apt
    apt-get update || true
fi

exec "$@"
