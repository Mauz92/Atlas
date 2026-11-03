"""Local-first sync protocol v1, server side (SYNC-03; ``docs/SYNC_PROTOCOL.md``).

Deliberately import-free: the ORM models import :mod:`atlas.sync.fields` for column defaults, so
this package must not import the models back. Import the submodules directly:

- :mod:`atlas.sync.fields` — tracked fields, ``field_revisions`` upkeep and the pure merge planner.
- :mod:`atlas.sync.protocol` — the ``Atlas-Sync`` header, version negotiation, ``426`` and the
  structured sync-mode error.
- :mod:`atlas.sync.epoch` — the instance epoch (D9/D12).
"""
