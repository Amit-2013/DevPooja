"""CI wiring guards — make the scheduled drift-catcher and the runner-image pin
self-protecting, so neither silently disappears.

Why both matter:
- The monthly schedule (3rd, 05:23 UTC) catches drift between pushes: new GitHub
  advisories fail the npm audit gate with no code change, backend-python floats
  its dependencies on >= bounds so `pip install -r` can pull breaking releases,
  and the pinned runner image still gets patch refreshes.
- The ubuntu-24.04 pin removes runner-image drift that twice failed the Node
  test step with no related code change (see a536278).

The pin guard also carries the retirement-review reminder: GitHub announces
image retirements in actions/runner-images with brownout warnings before
removal. When that happens, re-pin to the newest available LTS."""
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / ".github/workflows/ci.yml"
PAGES = ROOT / ".github/workflows/pages.yml"


def _ci() -> dict:
    return yaml.safe_load(CI.read_text(encoding="utf-8"))


def test_monthly_schedule_present():
    triggers = _ci()[True]  # PyYAML parses the bare `on:` key as boolean True
    assert "schedule" in triggers, "the monthly drift-catcher cron was removed"
    crons = [t.get("cron") for t in triggers["schedule"]]
    assert "23 5 3 * *" in crons, f"unexpected cron set: {crons}"
    # a fixed day-of-month keeps it a true monthly cadence (not weekly drift)
    day = crons[0].split()[2]
    assert day.isdigit() and 1 <= int(day) <= 28


def test_runner_pin_present_in_both_workflows():
    for path, jobs in ((CI, ("node-tests", "python-tests")), (PAGES, ("build",))):
        cfg = yaml.safe_load(path.read_text(encoding="utf-8"))
        for job in jobs:
            runs_on = cfg["jobs"][job]["runs-on"]
            assert runs_on == "ubuntu-24.04", (
                f"{path.name}:{job} unpinned ({runs_on}) — re-pin to a fixed "
                "image, ubuntu-latest drift has caused phantom failures here")


def test_pin_matches_a_currently_supported_image():
    """Retirement review hook: ubuntu-24.04 is supported until announced otherwise.
    When GitHub retires it (actions/runner-images announcement + brownouts),
    this test's skip message is the reminder to re-pin to the newest LTS."""
    runs_on = _ci()["jobs"]["node-tests"]["runs-on"]
    version = runs_on.replace("ubuntu-", "") if runs_on.startswith("ubuntu-") else ""
    # Supported pinned ubuntu images as of 2026-09: 22.04 and 24.04. Bump this
    # set when 26.04 lands or when 22.04/24.04 retirement is announced.
    supported = {"22.04", "24.04"}
    if version not in supported:
        pytest.skip(
            f"Runner image '{runs_on}' is not in the known-supported set {sorted(supported)} "
            "— perform the retirement review: re-pin both workflows to the newest "
            "ubuntu LTS, run both suites, update this set.")


def test_schedule_review_note_is_current():
    """The comment block above the cron must not go stale: it should not claim a
    review year that has already passed."""
    text = CI.read_text(encoding="utf-8")
    years = re.findall(r"REVIEW[- ]BY: (\d{4})", text)
    this_year = datetime.now(timezone.utc).year
    for y in years:
        assert int(y) >= this_year, (
            f"ci.yml pins a REVIEW-BY {y} that has passed — review the ubuntu-24.04 "
            "pin and the schedule now, then update the note")


def test_audit_gate_still_gates():
    """The drift-catcher's headline value is a gating audit step; keep it gated."""
    text = CI.read_text(encoding="utf-8")
    assert "npm audit --audit-level=high" in text
    block = text.split("npm audit --audit-level=high", 1)[1][:300]
    assert "continue-on-error" not in block


def test_python_audit_step_present_and_gating():
    """pip-audit mirrors the Node gate: present in the python job, run against
    requirements.txt (the full transitive closure), never continue-on-error."""
    cfg = _ci()
    py_job = cfg["jobs"]["python-tests"]
    steps = py_job["steps"]
    audit = [s for s in steps if "pip_audit" in str(s.get("run", ""))]
    assert audit, "the pip-audit step was removed from the Python job"
    run_block = audit[0]["run"]
    assert "pip_audit -r requirements.txt" in run_block, (
        "pip-audit must scan the requirements file, not the live environment, "
        "so the floating >= bounds are audited at their resolved versions")
    assert not audit[0].get("continue-on-error"), (
        "the pip-audit step must gate the job, mirroring the Node npm audit gate")
    # both backends audited -> the drift-catcher scans the whole dependency surface
    node_text = CI.read_text(encoding="utf-8")
    assert "npm audit --audit-level=high" in node_text
