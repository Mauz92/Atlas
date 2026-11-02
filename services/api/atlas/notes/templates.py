"""Daily-note paths and note templates (MU-07, ADR-0049).

A template is an ordinary Markdown note in the ``templates/`` folder. Its content is untrusted
text: the only processing is a single pass that replaces the placeholders ``{{date}}`` and
``{{title}}`` (optional inner spaces allowed). Anything else, including other ``{{...}}`` text, is
copied verbatim; nothing is evaluated, included or fetched.
"""

from __future__ import annotations

import re
from datetime import date

DAILY_DIR = "daily"
TEMPLATES_DIR = "templates"

_DAY = re.compile(r"\d{4}-\d{2}-\d{2}", re.ASCII)
_PLACEHOLDER = re.compile(r"\{\{\s*(date|title)\s*\}\}")


class TemplateError(ValueError):
    """The request names something that cannot be used as a template or a day."""


def parse_day(value: str) -> str:
    """Return ``value`` if it is a real calendar day written ``YYYY-MM-DD``."""
    if _DAY.fullmatch(value):
        try:
            date.fromisoformat(value)
        except ValueError:
            pass
        else:
            return value
    raise TemplateError("date must be a calendar day written YYYY-MM-DD")


def render_template(text: str, *, title: str, day: str) -> str:
    """Substitute ``{{date}}`` and ``{{title}}`` in one pass (values are not re-expanded)."""
    values = {"date": day, "title": title}
    return _PLACEHOLDER.sub(lambda match: values[match.group(1)], text)
