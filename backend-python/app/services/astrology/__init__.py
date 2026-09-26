"""Facade for the astrology service layer — port of services/astrology/index.js.
Route code should only use this."""
from . import ephemeris
from .dosh_engine import analyze, detected
from .kundali_engine import analysis_view, build_chart
from .recommendation_engine import havan_for, recommendations_for, samagri_for
