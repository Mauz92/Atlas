from httpx import ASGITransport, AsyncClient

from tests.conftest import create_user_via_setup

PASSWORD = "correct horse battery"


async def test_api_responses_are_not_cached(client: AsyncClient) -> None:
    response = await client.get("/api/setup/status")
    assert response.headers.get("cache-control") == "no-store"


async def test_session_cookie_is_httponly_and_samesite(client: AsyncClient) -> None:
    await create_user_via_setup(client, password=PASSWORD)
    response = await client.post(
        "/api/auth/login", json={"email": "owner@example.com", "password": PASSWORD}
    )
    cookies = "; ".join(response.headers.get_list("set-cookie")).lower()
    assert "atlas_session=" in cookies
    assert "httponly" in cookies
    assert "samesite=lax" in cookies


async def test_unknown_account_and_wrong_password_are_indistinguishable(
    client: AsyncClient,
) -> None:
    await create_user_via_setup(client, password=PASSWORD)
    unknown = await client.post(
        "/api/auth/login", json={"email": "nobody@example.com", "password": PASSWORD}
    )
    wrong = await client.post(
        "/api/auth/login", json={"email": "owner@example.com", "password": "wrong-password"}
    )
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json() == wrong.json() == {"detail": "Invalid credentials"}


async def test_production_sets_hsts_and_disables_interactive_docs(monkeypatch) -> None:
    """T9 (accidental public exposure): production posture — HSTS on responses, no API docs.

    The security-headers middleware (``atlas/middleware.py``) adds ``Strict-Transport-Security``
    only when ``ATLAS_ENV=production`` and the app factory disables ``/api/docs`` in production.
    Both are asserted here so the production-only branches are exercised, not merely inspected.
    """
    from atlas import main as main_module
    from atlas import middleware as middleware_module
    from atlas.config import Settings

    settings = Settings(
        atlas_env="production",
        secret_key="a-real-secret",
        session_secret="another-real-secret",
        token_encryption_key="yet-another-real-secret",
        public_base_url="https://atlas.example",
    )
    monkeypatch.setattr(main_module, "get_settings", lambda: settings)
    monkeypatch.setattr(middleware_module, "get_settings", lambda: settings)
    app = main_module.create_app()

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="https://atlas.example"
    ) as production:
        health = await production.get("/health")
        docs = await production.get("/api/docs")

    assert health.status_code == 200
    assert health.headers["strict-transport-security"].startswith("max-age=")
    assert "content-security-policy" in health.headers
    assert health.headers["x-content-type-options"] == "nosniff"
    # Interactive docs are needless surface in production and are disabled.
    assert docs.status_code == 404


async def test_trusted_host_rejects_unknown_host(monkeypatch) -> None:
    from atlas import main as main_module
    from atlas.config import Settings

    settings = Settings(allowed_hosts=["atlas.example.com"])
    monkeypatch.setattr(main_module, "get_settings", lambda: settings)
    app = main_module.create_app()

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://evil.example"
    ) as attacker:
        rejected = await attacker.get("/health")

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://atlas.example.com"
    ) as allowed:
        accepted = await allowed.get("/health")

    assert rejected.status_code == 400
    assert accepted.status_code == 200
