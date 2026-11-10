"""Time-zone name resolution shared by the adapters (ADR-0071).

Providers and feeds name zones three ways: IANA (``Europe/Berlin``), Windows/Outlook
(``W. Europe Standard Time``) and, in ICS, an arbitrary ``TZID`` that may only be defined by an
embedded ``VTIMEZONE``. :func:`resolve_zone` turns any of them into a valid IANA name or falls back,
so a projected event always carries a zone the viewer's browser and ``zoneinfo`` both understand.
The Windows table is the commonly used subset of the Unicode CLDR ``windowsZones`` mapping (the
territory-001 "golden" zone of each entry); a name that is not listed falls back rather than guess.
"""

from __future__ import annotations

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

WINDOWS_TO_IANA: dict[str, str] = {
    "UTC": "UTC",
    "Dateline Standard Time": "Etc/GMT+12",
    "Hawaiian Standard Time": "Pacific/Honolulu",
    "Alaskan Standard Time": "America/Anchorage",
    "Pacific Standard Time": "America/Los_Angeles",
    "Mountain Standard Time": "America/Denver",
    "US Mountain Standard Time": "America/Phoenix",
    "Central Standard Time": "America/Chicago",
    "Central America Standard Time": "America/Guatemala",
    "Central Standard Time (Mexico)": "America/Mexico_City",
    "Eastern Standard Time": "America/New_York",
    "SA Pacific Standard Time": "America/Bogota",
    "Atlantic Standard Time": "America/Halifax",
    "Newfoundland Standard Time": "America/St_Johns",
    "E. South America Standard Time": "America/Sao_Paulo",
    "Argentina Standard Time": "America/Argentina/Buenos_Aires",
    "Greenland Standard Time": "America/Godthab",
    "Azores Standard Time": "Atlantic/Azores",
    "GMT Standard Time": "Europe/London",
    "Greenwich Standard Time": "Atlantic/Reykjavik",
    "W. Europe Standard Time": "Europe/Berlin",
    "Central Europe Standard Time": "Europe/Budapest",
    "Central European Standard Time": "Europe/Warsaw",
    "Romance Standard Time": "Europe/Paris",
    "W. Central Africa Standard Time": "Africa/Lagos",
    "E. Europe Standard Time": "Europe/Chisinau",
    "GTB Standard Time": "Europe/Bucharest",
    "FLE Standard Time": "Europe/Kiev",
    "Turkey Standard Time": "Europe/Istanbul",
    "Israel Standard Time": "Asia/Jerusalem",
    "South Africa Standard Time": "Africa/Johannesburg",
    "Egypt Standard Time": "Africa/Cairo",
    "Arab Standard Time": "Asia/Riyadh",
    "Russian Standard Time": "Europe/Moscow",
    "E. Africa Standard Time": "Africa/Nairobi",
    "Arabian Standard Time": "Asia/Dubai",
    "Iran Standard Time": "Asia/Tehran",
    "Pakistan Standard Time": "Asia/Karachi",
    "India Standard Time": "Asia/Kolkata",
    "Sri Lanka Standard Time": "Asia/Colombo",
    "Nepal Standard Time": "Asia/Katmandu",
    "Bangladesh Standard Time": "Asia/Dhaka",
    "SE Asia Standard Time": "Asia/Bangkok",
    "China Standard Time": "Asia/Shanghai",
    "Singapore Standard Time": "Asia/Singapore",
    "W. Australia Standard Time": "Australia/Perth",
    "Taipei Standard Time": "Asia/Taipei",
    "Tokyo Standard Time": "Asia/Tokyo",
    "Korea Standard Time": "Asia/Seoul",
    "Cen. Australia Standard Time": "Australia/Adelaide",
    "AUS Central Standard Time": "Australia/Darwin",
    "E. Australia Standard Time": "Australia/Brisbane",
    "AUS Eastern Standard Time": "Australia/Sydney",
    "Tasmania Standard Time": "Australia/Hobart",
    "New Zealand Standard Time": "Pacific/Auckland",
    "Tonga Standard Time": "Pacific/Tongatapu",
}


def is_iana(name: str | None) -> bool:
    if not name or not name.strip() or name.strip().startswith(("/", ".")) or ".." in name:
        return False
    try:
        ZoneInfo(name.strip())
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return False
    return True


def resolve_zone(name: str | None, default: str = "UTC") -> str:
    """A valid IANA zone name for ``name`` (IANA or Windows), else ``default``."""
    if name is None:
        return default
    candidate = name.strip().strip('"')
    if is_iana(candidate):
        return candidate
    mapped = WINDOWS_TO_IANA.get(candidate)
    if mapped and is_iana(mapped):
        return mapped
    return default
