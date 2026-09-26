"""Registry of condition rules — port of rules/index.js. Adding a new dosh: create
a rule module here, register it below, and add a kundali_conditions row (see
migrations or the admin panel). Rules are pure functions:
view -> {detected, severity, confidence, evidence, evidenceHi}."""
from . import (grahan_dosh, guru_chandal_yoga, kaal_sarp_dosh, ketu_conditions,
               mangal_dosh, nadi_dosh, pitru_dosh, rahu_conditions, shani_conditions)

REGISTRY = {
    'mangal_dosha': mangal_dosh,
    'kaal_sarp': kaal_sarp_dosh,
    'pitru_dosha': pitru_dosh,
    'nadi_dosha': nadi_dosh,
    'grahan_dosha': grahan_dosh,
    'guru_chandal': guru_chandal_yoga,
    'shani_condition': shani_conditions,
    'rahu_condition': rahu_conditions,
    'ketu_condition': ketu_conditions,
}


def get(code: str):
    return REGISTRY.get(code)
