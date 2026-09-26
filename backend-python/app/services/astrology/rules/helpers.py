"""Shared helpers for dosh rules — port of rules/helpers.js. Every rule is a pure
function of the analysis view: it receives { lagnaSign, moonSign, planets:{...},
dasha } and returns None (not detected) or
{ detected, severity, confidence, evidence:[...], evidenceHi:[...] }."""

HOUSES_HIGH = [7, 8]


def house_from(planet: dict, ref_sign: int) -> int:
    """House of a planet counted from a reference sign (1-based)."""
    return ((planet["sign"] - ref_sign + 12) % 12) + 1


def exalted(p: dict) -> bool:
    return p["dignity"] == "Exalted"


def debilitated(p: dict) -> bool:
    return p["dignity"] == "Debilitated"


def own_sign(p: dict) -> bool:
    return p["dignity"] == "Own sign"


def ordinal(n: int) -> str:
    return "st" if n == 1 else "nd" if n == 2 else "rd" if n == 3 else "th"
