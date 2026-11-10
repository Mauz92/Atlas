"""The production adapter registry: real Google and Microsoft adapters (M5-03/M5-04).

Kept apart from :func:`atlas.calendar.adapter.default_registry` (which stays empty so a unit test or
a deployment without credentials can never reach a real provider by accident): the API and the
worker ask for :func:`production_registry` explicitly. ICS feeds are not credentials and are built
from their source row (:mod:`atlas.calendar.sources`), not through this registry.
"""

from __future__ import annotations

from .adapter import AdapterRegistry
from .google import google_adapter_factory
from .microsoft import microsoft_adapter_factory
from .oauth import GOOGLE, MICROSOFT


def production_registry() -> AdapterRegistry:
    registry = AdapterRegistry()
    registry.register(GOOGLE, google_adapter_factory)
    registry.register(MICROSOFT, microsoft_adapter_factory)
    return registry
