"""Start the real API for the sync-core conformance run (throwaway database only).

Identical to ``uvicorn atlas.main:app`` except that the per-device rate limits are lifted: the
simulation drives hundreds of requests in a few real seconds (virtual time), which the production
limits (600 requests / 120 writes a minute) would answer with 429. The limits themselves are
tested by the server's own suite; the client's 429 handling by ``engine.test.ts``.

Usage: python serve.py <port>
"""

import sys

import uvicorn

import atlas.auth.devices as devices

for limiter in (devices.device_request_limiter, devices.device_write_limiter):
    limiter._limit = 10**9  # noqa: SLF001

uvicorn.run("atlas.main:app", host="127.0.0.1", port=int(sys.argv[1]), log_level="warning")
