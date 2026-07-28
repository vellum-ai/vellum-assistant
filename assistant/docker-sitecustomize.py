"""Vellum: expose the persistent apt/pip chroot as site directories.

Installed at /usr/lib/python3/dist-packages/sitecustomize.py in the assistant
image. PYTHONPATH (set by docker-kata-apt-env.sh and buildSanitizedEnv) makes
plain modules importable, but .pth files (e.g. from `pip install -e`) are only
processed for site directories, so the chroot dirs must also be registered
here. Virtualenvs without --system-site-packages never import this module,
which is intended — venvs are self-contained.
"""

import os

if os.environ.get("VELLUM_SANDBOX_RUNTIME") in (
    "kata",
    "firecracker",
    "cloud-hypervisor",
):
    import site
    import sys

    _root = os.environ.get("VELLUM_APT_DATA_ROOT", "/data/system")
    _version = "%d.%d" % sys.version_info[:2]
    # pip dir before apt dir, matching the PYTHONPATH precedence.
    for _dir in (
        "%s/usr/local/lib/python%s/dist-packages" % (_root, _version),
        "%s/usr/lib/python3/dist-packages" % _root,
    ):
        if os.path.isdir(_dir):
            site.addsitedir(_dir)
