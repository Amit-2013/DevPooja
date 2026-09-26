"""Dosh analysis engine — port of services/astrology/doshEngine.js.

The set of conditions and their metadata (name, description, default severity,
enabled/disabled) live in the kundali_conditions table — admins control them.
The astrological evaluation logic lives in rules/*.py, keyed by condition code.
The engine combines both and returns structured, explainable results in BOTH
languages: English fields are the source of truth (and the fallback), while
nameHi / explanationHi / evidenceHi carry the Hindi presentation. The UI picks
the language; the chart is analysed once."""
import sys

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...models import KundaliCondition
from . import kundali_engine
from . import rules


async def analyze(db: AsyncSession, chart: dict, now=None) -> list[dict]:
    """Evaluates every active condition that has a rule. Disabled conditions are
    skipped. chart: full chart dict; now: datetime for transit rules."""
    view = kundali_engine.analysis_view(chart)
    rows = (await db.execute(
        select(KundaliCondition).where(KundaliCondition.active == 1))).scalars().all()

    results = []
    for c in rows:
        rule = rules.get(c.code)
        if not rule:
            continue  # a DB condition without a rule module: shown as "not evaluated"
        try:
            out = rule.evaluate(view, now, chart.get('partner'))
        except Exception as e:
            # a broken rule must never break the whole analysis
            print('[doshEngine] rule ' + c.code + ' failed: ' + str(e), file=sys.stderr)
            continue
        if not out:
            results.append({
                'code': c.code, 'name': c.name, 'nameHi': c.name_hi or '',
                'detected': False, 'severity': 'none', 'confidence': None,
                'explanation': c.descr or '', 'explanationHi': c.descr_hi or '',
                'evidence': [], 'evidenceHi': [], 'remedies': [],
            })
            continue
        results.append({
            'code': c.code,
            'name': c.name,
            'nameHi': c.name_hi or '',
            'detected': bool(out.get('detected')),
            'severity': out.get('severity') or 'low',
            'confidence': out.get('confidence'),
            'explanation': c.descr or '',
            'explanationHi': c.descr_hi or '',
            'evidence': out.get('evidence') or [],
            'evidenceHi': out.get('evidenceHi') or [],
            'remedies': [],
            'remedyHi': c.remedy_hi or '',
        })
    return results


# Only the detected ones, sorted by severity.
_ORDER = {'high': 0, 'medium': 1, 'low': 2}


def detected(results: list[dict]) -> list[dict]:
    return sorted((r for r in results if r['detected']),
                  key=lambda r: _ORDER.get(r['severity'], 3))
