"""Atlas application API and background worker."""

import os

#: Release images are built with ``ATLAS_VERSION`` (``.github/workflows/release.yml``); a source
#: checkout reports the development version.
__version__ = os.environ.get("ATLAS_VERSION") or "0.1.0"
