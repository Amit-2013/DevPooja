"""Trial poojas (master plan Phase 18) — async twin of server/services/trial.js.
Activates the migration-014 `trial_poojas` table (schema unchanged; the
TrialPooja model already exists in models.py).

Flow: admin schedules a trial (date + service), the pandit performs it, the
admin records the assessment. The 7 scoring dimensions mirror qa_records, but a
trial is all-or-nothing: every dimension must be scored 1..5 (an activation
decision must never rest on a partial picture). final_score = round(mean*10)/10.

Result vocabulary (trial_poojas.result):
  PENDING                scheduled, not yet assessed
  PASSED                 final_score >= pass mark (setting 'trial_pass_mark',
                         default 3.5) — unlocks activation
  FAILED                 final_score < pass mark (or evaluator-forced for cause)
  REASSESSMENT_REQUIRED  score qualified but the evaluator flagged issues

Activation gate: an admin cannot flip a pandit to status='verified' until that
pandit has a PASSED trial (assert_activation_allowed is consumed by the admin
route; the gate is audited). Existing verified pandits are grandfathered — the
gate only fires on the transition INTO 'verified'.

Every write is audited with old→new values; the pandit is notified on every
result. Parity note: the Node service stores evaluator as an actor id and the
Python side does the same (audit trail carries the actor).
"""
import json
import re
import time

from sqlalchemy import select

from ..models import AuditLog, Notif, Pandit, Setting, TrialPooja
from ..util import bad, conflict, not_found, rid

DIMENSIONS = ["punctuality", "communication", "ritual_compliance", "presentation",
              "customer_interaction", "digital_capability", "documentation"]
RESULTS = ["PENDING", "PASSED", "FAILED", "REASSESSMENT_REQUIRED"]

_COLUMN_BY_DIM = {
    "punctuality": "punctuality", "communication": "communication",
    "ritual_compliance": "ritual_compliance", "presentation": "presentation",
    "customer_interaction": "customer_interaction", "digital_capability": "digital_capability",
    "documentation": "documentation",
}


def _now_ms() -> int:
    return int(time.time() * 1000)


async def get_setting(db, key: str, default):
    row = (await db.execute(select(Setting).where(Setting.key == key))).scalar_one_or_none()
    return json.loads(row.value) if row else default


async def pass_mark(db) -> float:
    n = await get_setting(db, "trial_pass_mark", 3.5)
    try:
        n = float(n)
    except (TypeError, ValueError):
        return 3.5
    return n if 1 <= n <= 5 else 3.5


def out(r: TrialPooja) -> dict:
    return r and {
        "id": r.id, "panditId": r.pandit_id, "evaluator": r.evaluator, "date": r.date,
        "service": r.service,
        "scores": {
            "punctuality": r.punctuality, "communication": r.communication,
            "ritualCompliance": r.ritual_compliance, "presentation": r.presentation,
            "customerInteraction": r.customer_interaction,
            "digitalCapability": r.digital_capability, "documentation": r.documentation,
        },
        "finalScore": r.final_score, "result": r.result,
        "adminNotes": r.admin_notes or "", "createdAt": r.created_at,
    }


async def list_trials(db) -> list[dict]:
    rows = (await db.execute(select(TrialPooja).order_by(
        TrialPooja.created_at.desc(), TrialPooja.id.desc()))).scalars().all()
    return [out(r) for r in rows]


async def for_pandit(db, pandit_id: str) -> list[dict]:
    rows = (await db.execute(select(TrialPooja).where(TrialPooja.pandit_id == pandit_id)
                             .order_by(TrialPooja.created_at.desc(), TrialPooja.id.desc()))).scalars().all()
    return [out(r) for r in rows]


async def latest(db, pandit_id: str) -> dict | None:
    row = (await db.execute(select(TrialPooja).where(TrialPooja.pandit_id == pandit_id)
                            .order_by(TrialPooja.created_at.desc(), TrialPooja.id.desc()))).scalars().first()
    return out(row) if row else None


async def _audit(db, actor, action, entity, entity_id, detail, old_value=None, new_value=None) -> None:
    db.add(AuditLog(actor_user_id=actor or None, actor_role="admin" if actor else "system",
                    action=action, entity=entity, entity_id=entity_id,
                    detail=json.dumps(detail),
                    old_value=json.dumps(old_value) if old_value is not None else None,
                    new_value=json.dumps(new_value) if new_value is not None else None,
                    created_at=_now_ms()))


async def gate_status(db, pandit_id: str) -> dict:
    """The gate: activation requires a PASSED trial (parity: trial.gateStatus)."""
    best = (await db.execute(select(TrialPooja).where(
        TrialPooja.pandit_id == pandit_id, TrialPooja.result == "PASSED")
        .order_by(TrialPooja.created_at.desc(), TrialPooja.id.desc()))).scalars().first()
    if best:
        return {"ok": True, "reason": None, "trial": out(best)}
    any_row = await latest(db, pandit_id)
    if not any_row:
        return {"ok": False, "trial": None,
                "reason": "No trial pooja has been assessed for this pandit yet — schedule one and record the result before activation."}
    if any_row["result"] == "PENDING":
        return {"ok": False, "trial": any_row,
                "reason": f"The scheduled trial ({any_row['id']}, {any_row['date'] or 'unscheduled'}) has not been assessed yet."}
    return {"ok": False, "trial": any_row,
            "reason": f"The latest trial ({any_row['id']}) ended {any_row['result']} — schedule a new trial before activation."}


async def assert_activation_allowed(db, pandit_id: str) -> dict:
    g = await gate_status(db, pandit_id)
    if not g["ok"]:
        raise conflict(g["reason"])
    return g["trial"]


async def schedule(db, actor, body: dict) -> dict:
    pandit_id = (body or {}).get("panditId")
    p = await db.get(Pandit, pandit_id) if pandit_id else None
    if not p:
        raise not_found("Pandit not found")
    date = str((body or {}).get("date") or "")
    if not date or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise bad("Trial date is required (YYYY-MM-DD)")
    svc = str((body or {}).get("service") or "").strip()
    if not svc:
        raise bad("Name the service the trial will cover (e.g. Satyanarayan Katha)")
    tid = "TR" + rid(6)
    notes = (body or {}).get("notes")
    db.add(TrialPooja(id=tid, pandit_id=pandit_id, evaluator=actor or None, date=date,
                      service=svc[:80], result="PENDING",
                      admin_notes=(str(notes)[:500] if notes else None),
                      created_at=_now_ms()))
    await db.flush()
    await _audit(db, actor, "trial.scheduled", "trial_pooja", tid,
                 {"panditId": pandit_id, "date": date, "service": svc[:80]},
                 new_value={"result": "PENDING", "date": date, "service": svc[:80]})
    if p.user_id:
        db.add(Notif(user_id=p.user_id, channel="In-App",
                     message=f"A trial puja has been scheduled for you on {date} ({svc}).",
                     ts=_now_ms()))
    return out(await db.get(TrialPooja, tid))


async def record(db, actor, tid: str, body: dict) -> dict:
    row = await db.get(TrialPooja, tid)
    if not row:
        raise not_found("Trial not found")
    if row.result != "PENDING":
        raise conflict(f"Trial already assessed ({row.result}) — schedule a new one")
    b = body or {}
    scores = b.get("scores") if isinstance(b.get("scores"), dict) else b

    def _camel(k):
        return re.sub(r"_([a-z])", lambda m: m.group(1).upper(), k)

    given = {}
    for k in DIMENSIONS:
        val = scores.get(k, scores.get(_camel(k)))
        if val is None or val == "":
            raise bad(f"{k} is required for a trial assessment (all 7 dimensions, 1..5)")
        try:
            n = int(val)
        except (TypeError, ValueError):
            raise bad(f"{k} must be an integer 1..5")
        if not 1 <= n <= 5:
            raise bad(f"{k} must be an integer 1..5")
        given[k] = n
    mean = sum(given.values()) / len(DIMENSIONS)
    final_score = round(mean * 10) / 10
    force = b.get("forceResult")
    if force and force not in ("FAILED", "REASSESSMENT_REQUIRED"):
        raise bad("forceResult may only be FAILED or REASSESSMENT_REQUIRED")
    if force == "FAILED":
        result = "FAILED"
    elif force == "REASSESSMENT_REQUIRED":
        result = "REASSESSMENT_REQUIRED"
    else:
        result = "PASSED" if final_score >= await pass_mark(db) else "FAILED"
    notes = b.get("notes")
    if result == "REASSESSMENT_REQUIRED" and not notes:
        raise bad("Say what went wrong — a reassessment requires written feedback")
    old = row.result
    row.evaluator = actor or row.evaluator
    row.punctuality = given["punctuality"]
    row.communication = given["communication"]
    row.ritual_compliance = given["ritual_compliance"]
    row.presentation = given["presentation"]
    row.customer_interaction = given["customer_interaction"]
    row.digital_capability = given["digital_capability"]
    row.documentation = given["documentation"]
    row.final_score = final_score
    row.result = result
    row.admin_notes = (str(notes)[:500] if notes else row.admin_notes)
    await db.flush()
    await _audit(db, actor, "trial.recorded", "trial_pooja", tid,
                 {"panditId": row.pandit_id, "scores": given, "finalScore": final_score,
                  "result": result},
                 old_value={"result": old}, new_value={"result": result, "finalScore": final_score})
    p = await db.get(Pandit, row.pandit_id)
    if p and p.user_id:
        msg = (f"Your trial puja was assessed: {final_score}/5 — PASSED. Your activation can now proceed."
               if result == "PASSED" else
               f"Your trial puja was assessed: {final_score}/5 — not passed. See the admin feedback and schedule a new trial."
               if result == "FAILED" else
               f"Your trial puja was assessed: {final_score}/5 — a reassessment has been requested. See the admin feedback.")
        db.add(Notif(user_id=p.user_id, channel="In-App", message=msg, ts=_now_ms()))
    return out(row)
