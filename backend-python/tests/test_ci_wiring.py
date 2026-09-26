"""CI wiring guards — make the scheduled drift-catcher, the runner-image pin and
the reusable-workflow extraction self-protecting, so none of them silently
disappears or forks.

Structure under guard:
- .github/workflows/node-tests.yml   — Node job single source of truth
- .github/workflows/python-tests.yml — Python job single source of truth
- .github/workflows/ci.yml           — triggers only (push/PR/monthly schedule)
- .github/workflows/pages.yml        — calls node-tests.yml before publishing

Why each matters:
- The monthly schedule (3rd, 05:23 UTC) catches drift between pushes: new GitHub
  advisories fail the audit gates with no code change, backend-python floats
  its dependencies on >= bounds so `pip install -r` can pull breaking releases,
  and the pinned runner image still gets patch refreshes.
- The ubuntu-24.04 pin removes runner-image drift that twice failed the Node
  test step with no related code change (see a536278).
- Callers must keep calling the reusable workflows: re-inlining job steps into
  ci.yml/pages.yml would fork the setup and defeat the single source of truth.

The pin guard also carries the retirement-review reminder: GitHub announces
image retirements in actions/runner-images with brownout warnings before
removal. When that happens, re-pin to the newest available LTS."""
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

ROOT = Path(__file__).resolve().parents[2]
WF = ROOT / ".github/workflows"
CI = WF / "ci.yml"
PAGES = WF / "pages.yml"
NODE = WF / "node-tests.yml"
PYTHON = WF / "python-tests.yml"

REUSABLE = {"node-tests.yml", "python-tests.yml"}


def _load(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _triggers(path: Path) -> dict:
    """The `on:` key parses as boolean True under PyYAML."""
    return _load(path)[True]


def test_monthly_schedule_present():
    triggers = _triggers(CI)
    assert "schedule" in triggers, "the monthly drift-catcher cron was removed"
    crons = [t.get("cron") for t in triggers["schedule"]]
    assert "23 5 3 * *" in crons, f"unexpected cron set: {crons}"
    # a fixed day-of-month keeps it a true monthly cadence (not weekly drift)
    day = crons[0].split()[2]
    assert day.isdigit() and 1 <= int(day) <= 28


def test_manual_dispatch_available():
    """The drift-catcher must stay runnable on demand: the monthly schedule is
    the fallback, not the only trigger. After a new advisory lands or a
    floating dependency looks suspect, an operator reruns the audit gates
    immediately instead of waiting for the cron."""
    triggers = _triggers(CI)
    assert "workflow_dispatch" in triggers, (
        "ci.yml lost workflow_dispatch — manual drift-catcher runs must stay "
        "available so the audit gates can be rerun between pushes")


def test_ci_jobs_call_the_reusable_workflows():
    jobs = _load(CI)["jobs"]
    uses = {name: cfg.get("uses") for name, cfg in jobs.items()}
    assert uses.get("node") == "./.github/workflows/node-tests.yml", uses
    assert uses.get("python") == "./.github/workflows/python-tests.yml", uses
    for name, cfg in jobs.items():
        assert "steps" not in cfg, (
            f"ci.yml job '{name}' has inline steps — job definitions belong in "
            "the reusable workflows, ci.yml owns triggers only")


def test_pages_gates_on_the_shared_node_tests():
    cfg = _load(PAGES)
    jobs = cfg["jobs"]
    assert jobs["tests"].get("uses") == "./.github/workflows/node-tests.yml", (
        "pages.yml must gate publishing on the shared Node test job")
    assert jobs["build"].get("needs") == "tests", (
        "pages.yml build must keep needs: tests — never publish a broken snapshot")
    assert "steps" not in jobs["tests"]


def test_runner_pin_present_in_reusable_jobs_and_pages():
    # Both reusable workflows carry the pin; pages' build job (which runs on a
    # real runner, unlike its `tests` caller) must stay pinned too.
    pins = {
        (NODE, "node-tests"): _load(NODE)["jobs"]["node-tests"]["runs-on"],
        (PYTHON, "python-tests"): _load(PYTHON)["jobs"]["python-tests"]["runs-on"],
        (PAGES, "build"): _load(PAGES)["jobs"]["build"]["runs-on"],
    }
    for (path, job), runs_on in pins.items():
        assert runs_on == "ubuntu-24.04", (
            f"{path.name}:{job} unpinned ({runs_on}) — re-pin to a fixed image, "
            "ubuntu-latest drift has caused phantom failures here")


def test_pin_matches_a_currently_supported_image():
    """Retirement review hook: ubuntu-24.04 is supported until announced otherwise.
    When GitHub retires it (actions/runner-images announcement + brownouts),
    this test's skip message is the reminder to re-pin to the newest LTS."""
    runs_on = _load(NODE)["jobs"]["node-tests"]["runs-on"]
    version = runs_on.replace("ubuntu-", "") if runs_on.startswith("ubuntu-") else ""
    # Supported pinned ubuntu images as of 2026-09: 22.04 and 24.04. Bump this
    # set when 26.04 lands or when 22.04/24.04 retirement is announced.
    supported = {"22.04", "24.04"}
    if version not in supported:
        pytest.skip(
            f"Runner image '{runs_on}' is not in the known-supported set {sorted(supported)} "
            "— perform the retirement review: re-pin both reusable workflows and "
            "pages.yml to the newest ubuntu LTS, run both suites, update this set.")


def test_review_note_is_current():
    """The REVIEW-BY notes must not go stale: a year that has already passed
    fails the suite, forcing the pin to be re-reviewed."""
    this_year = datetime.now(timezone.utc).year
    for path in (NODE, PYTHON):
        for y in re.findall(r"REVIEW[- ]BY: (\d{4})", _text(path)):
            assert int(y) >= this_year, (
                f"{path.name} pins a REVIEW-BY {y} that has passed — review the "
                "ubuntu-24.04 pin now, re-pin if retired, then update the note")


def test_node_audit_gate_lives_in_reusable_workflow_and_gates():
    text = _text(NODE)
    assert "npm audit --audit-level=high" in text
    block = text.split("npm audit --audit-level=high", 1)[1][:300]
    assert "continue-on-error" not in block


def test_python_audit_gate_lives_in_reusable_workflow_and_gates():
    """pip-audit mirrors the Node gate: run against requirements.txt (the full
    transitive closure), never continue-on-error."""
    job = _load(PYTHON)["jobs"]["python-tests"]
    audit = [s for s in job["steps"] if "pip_audit" in str(s.get("run", ""))]
    assert audit, "the pip-audit step was removed from python-tests.yml"
    run_block = audit[0]["run"]
    assert "pip_audit -r requirements.txt" in run_block, (
        "pip-audit must scan the requirements file, not the live environment, "
        "so the floating >= bounds are audited at their resolved versions")
    assert not audit[0].get("continue-on-error"), (
        "the pip-audit step must gate the job, mirroring the Node npm audit gate")


def test_reusable_workflows_are_workflow_call_only():
    """The shared files must expose exactly workflow_call (plus nothing that
    would let them run independently and double every push)."""
    for name in REUSABLE:
        triggers = _triggers(WF / name)
        assert set(triggers) == {"workflow_call"}, (
            f"{name} triggers are {sorted(triggers)} — reusable workflows should "
            "only expose workflow_call; ci.yml and pages.yml own the triggers")


def test_sharp_optional_dependency_guard_stays_in_place():
    """sharp's @img/* prebuilds are OPTIONAL npm deps; a flaked download silently
    disables WebP variants and phantom-fails the media tests. The install steps
    must keep verifying sharp loads and retrying once — removing this guard
    resurrects the undiagnosable failures from a536278-era runs."""
    for path in (NODE, PAGES):
        text = _text(path)
        assert "Verify sharp prebuilds landed" in text, (
            f"{path.name} lost the sharp install verification — required because "
            "npm silently skips flaked optional-dep downloads")
        assert "Retry install" in text, f"{path.name} lost the npm ci retry step"
