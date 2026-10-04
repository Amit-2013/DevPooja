"""Audit-document guards — pin MASTER-AUDIT.md's key claims to the real codebase
so the document and the code cannot silently drift apart (same philosophy as
test_ci_wiring.py: make documented guarantees self-protecting).

Under guard:
- the migration upper bound claimed in the inventory equals the highest
  server/migrations/*.sql on disk;
- every migration filename named in the document exists;
- the claimed report-id count equals BOTH registries (Node REPORTS + Python
  REPORT_TITLES), and the two registries agree with each other;
- every repo-relative code path the document cites exists;
- the claimed Python model count equals __tablename__ occurrences;
- every scaffolded migration-014 table has a mirrored SQLAlchemy model;
- every test suite named in the document exists, and every suite wired into
  package.json's test script is named in the document (both directions).

If a guard fails: the code changed (update the document as part of the same
commit) or the document claims something the code no longer does (fix the doc
or the code — never delete the guard to make the failure go away)."""
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DOC = ROOT / "MASTER-AUDIT.md"


def _doc() -> str:
    if not DOC.exists():
        pytest.skip("MASTER-AUDIT.md not present")
    return DOC.read_text(encoding="utf-8")


def _migrations() -> list[Path]:
    return sorted((ROOT / "server" / "migrations").glob("*.sql"))


def test_inventory_migration_upper_bound_matches_disk():
    m = re.search(r"migrations 001[–-](\d+)", _doc())
    assert m, "the inventory row must state the migration range (migrations 001–NNN)"
    claimed = int(m.group(1))
    on_disk = max(int(p.stem[:3]) for p in _migrations())
    assert claimed == on_disk, (
        f"MASTER-AUDIT.md claims migrations 001-{claimed:03d} but the newest file is "
        f"{on_disk:03d} — update the inventory row in the same commit as the migration")


def test_named_migrations_exist_on_disk():
    named = sorted(set(re.findall(r"\b(0\d\d_[a-z0-9_]+)\.sql", _doc())))
    disk = {p.name for p in _migrations()}
    # the regex captures the stem (the `.sql` sits outside the group), so the
    # disk set must be compared with the extension re-attached — otherwise
    # every correct citation would be reported as missing.
    missing = [n for n in named if n + ".sql" not in disk]
    assert not missing, f"the document cites migrations that do not exist: {missing}"


def _node_report_ids() -> list[str]:
    text = (ROOT / "server" / "routes" / "admin.js").read_text(encoding="utf-8")
    block = text.split("const REPORTS = {", 1)[1].split("\n};", 1)[0]
    return re.findall(r"(?:^|\n)  '?([a-z][a-z0-9-]*)'?: \(", block)


def _python_report_ids() -> list[str]:
    text = (ROOT / "backend-python" / "app" / "routers" / "reports_admin.py").read_text(encoding="utf-8")
    block = text.split("REPORT_TITLES = {", 1)[1].split("}", 1)[0]
    return re.findall(r"[\"']([a-z][a-z0-9-]*)[\"']\s*:", block)


def test_report_count_claim_matches_both_registries():
    m = re.search(r"\| Reports \| (\d+) ids", _doc())
    assert m, "the inventory row must state the report count"
    claimed = int(m.group(1))
    node, py = _node_report_ids(), _python_report_ids()
    assert claimed == len(node) == len(py), (
        f"document claims {claimed} report ids; Node registry has {len(node)}, "
        f"Python registry has {len(py)} — add new reports to BOTH registries and the doc")
    assert sorted(node) == sorted(py), (
        "Node and Python report registries disagree: "
        f"{sorted(set(node) ^ set(py))}")


def test_python_model_count_claim_matches_models():
    m = re.search(r"\| P models \| (\d+) \|", _doc())
    assert m, "the inventory row must state the Python model count"
    models = (ROOT / "backend-python" / "app" / "models.py").read_text(encoding="utf-8")
    actual = len(re.findall(r"__tablename__", models))
    assert int(m.group(1)) == actual, (
        f"document claims {m.group(1)} Python models; models.py defines {actual}")


def test_scaffolded_tables_have_mirrored_models():
    """Every table migration 014 creates must have a SQLAlchemy model — the
    scaffolding contract from the master plan."""
    sql = (ROOT / "server" / "migrations" / "014_master_scaffolding.sql").read_text(encoding="utf-8")
    tables = re.findall(r"CREATE TABLE IF NOT EXISTS (\w+)", sql)
    assert tables, "migration 014 lost its scaffolding tables"
    models = (ROOT / "backend-python" / "app" / "models.py").read_text(encoding="utf-8")
    defined = set(re.findall(r'__tablename__ = "(\w+)"', models))
    missing = [t for t in tables if t not in defined]
    assert not missing, f"migration 014 tables without mirrored models: {missing}"


def test_cited_code_paths_exist():
    doc = _doc()
    paths = set(re.findall(
        r"((?:tests|server|backend-python/tests|backend-python/app)/[A-Za-z0-9_./-]+\.(?:js|py|sql))", doc))
    assert paths, "the document should cite concrete code paths"
    missing = [p for p in sorted(paths) if not (ROOT / p).exists()]
    assert not missing, f"the document cites files that do not exist: {missing}"


def test_doc_test_suites_exist_and_cover_the_wired_suites():
    doc = _doc()
    # every suite the document names must exist on disk
    named = set(re.findall(r"(tests/[a-z0-9_.-]+\.test\.js|backend-python/tests/test_[a-z0-9_]+\.py)", doc))
    missing = [p for p in sorted(named) if not (ROOT / p).exists()]
    assert not missing, f"the document names test files that do not exist: {missing}"
    # every suite wired into npm test must be named in the document
    pkg = (ROOT / "package.json").read_text(encoding="utf-8")
    script = re.search(r'"test":\s*"node --test ([^"]+)"', pkg)
    assert script, "npm test must run the node --test suites explicitly"
    wired = set(re.findall(r"(tests/[a-z0-9_.-]+\.test\.js)", script.group(1)))
    assert wired <= named, (
        f"suites wired into package.json but not named in MASTER-AUDIT.md: {sorted(wired - named)} "
        "— update the document's test row in the same commit")
