"""Guards for the npm security posture that CI's audit step depends on.

The Node job gates on `npm audit --audit-level=high` (no continue-on-error).
That gate is safe only while the uuid override is real and effective, so these
tests document the resolution and fail loudly if it ever goes stale:
- exceljs declares uuid ^8.3.0, which carries 2 moderate advisories below 11.1.1;
- package.json overrides uuid to the patched ^11.1.0;
- removing the override reintroduces the vulnerable transitive (verified once
  by experiment: npm audit then reports the two moderates again).
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _pkg():
    return json.loads((ROOT / "package.json").read_text(encoding="utf-8"))


def _lock() -> dict:
    return json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))


def test_uuid_override_exists_for_exceljs():
    overrides = _pkg().get("overrides") or {}
    assert overrides.get("uuid") == "^11.1.0", (
        "The uuid override is the documented resolution for exceljs's vulnerable "
        "uuid ^8.3.0 (2 moderate advisories below 11.1.1). If this assertion "
        "fails, re-run `npm audit --audit-level=high` without the override before "
        "assuming the gate can be relaxed.")


def test_exceljs_still_declares_vulnerable_uuid_range():
    deps = _pkg()["dependencies"]
    assert "exceljs" in deps, "exceljs is the reason the override exists"
    assert deps["exceljs"].startswith("^4."), (
        "exceljs was upgraded — re-check whether uuid ^11 resolves natively and "
        "the override can be dropped")


def test_override_is_effective_in_the_lockfile():
    """npm dedupes overridden deps to a single top-level entry: exceljs must resolve
    uuid to the patched 11.x, not its own declared ^8.3.0."""
    lock = _lock()
    pk = lock.get("packages", {})
    exceljs_entry = pk.get("node_modules/exceljs")
    assert exceljs_entry and exceljs_entry.get("version", "").startswith("4."), (
        "lockfile has no exceljs 4.x — regenerate package-lock.json")
    uuid_entry = pk.get("node_modules/uuid")
    assert uuid_entry, "no top-level uuid in the lockfile — the override was dropped"
    version = uuid_entry.get("version", "")
    assert version.startswith("11."), (
        f"exceljs resolved uuid {version}; the override to ^11.1.0 is not effective")


def test_ci_audit_step_gates_without_continue_on_error():
    # The gate lives in the reusable workflow (node-tests.yml) since the
    # reusable-workflow extraction; ci.yml is a triggers-only caller.
    wf = (ROOT / ".github/workflows/node-tests.yml").read_text(encoding="utf-8")
    assert "npm audit --audit-level=high" in wf
    block = wf.split("npm audit --audit-level=high", 1)[1][:300]
    assert "continue-on-error: true" not in block, (
        "The audit step must gate the Node job; the uuid override is resolved")
