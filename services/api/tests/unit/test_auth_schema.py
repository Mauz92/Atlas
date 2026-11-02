import pytest
from pydantic import ValidationError

from atlas.api.schemas import LoginRequest, SetupRequest


@pytest.mark.parametrize("address", ["owner@home.test", "me@atlas.local", "Me@Example.COM"])
def test_single_owner_addresses_on_special_use_domains_are_accepted(address: str) -> None:
    request = SetupRequest(email=address, password="a-long-enough-password", display_name="Me")
    assert request.email.split("@")[0] == address.split("@")[0]
    assert LoginRequest(email=address, password="x").email == request.email


@pytest.mark.parametrize(
    "address",
    ["", "no-at-sign", "a@", "@b.example", "a b@example.com", "a@b.localhost", "a@b.invalid"],
)
def test_malformed_addresses_are_rejected(address: str) -> None:
    with pytest.raises(ValidationError):
        SetupRequest(email=address, password="a-long-enough-password", display_name="Me")
