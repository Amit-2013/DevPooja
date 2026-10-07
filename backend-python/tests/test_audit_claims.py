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
  package.json's test script is named in the document (both directions);
- the TEST COUNTS the document claims (MASTER-AUDIT Tests row + the three BRD
  sites) agree with each other AND with reality: the Node total against the
  suites wired into npm test, the Python total against pytest's own collection.

If a guard fails: the code changed (update the document as part of the same
commit) or the document claims something the code no longer does (fix the doc
or the code — never delete the guard to make the failure go away)."""
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DOC = ROOT / "MASTER-AUDIT.md"
BRD = ROOT / "BRD.md"


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


def _node_wired_count() -> int:
    """Node ground truth (static by design): every top-level `test(` registration
    in every suite wired into `npm test` — the same thing `node --test` totals
    (validated against the runner's own `tests 149` summary). The Python CI job
    has no node_modules, so this guard cannot EXECUTE the Node suite; the static
    parse keeps the documents pinned to the suites that actually run."""
    script = re.search(r'"test":\s*"node --test ([^"]+)"',
                       (ROOT / "package.json").read_text(encoding="utf-8"))
    assert script, "npm test must run the node --test suites explicitly"
    suites = re.findall(r"(tests/[a-z0-9_.-]+\.test\.js)", script.group(1))
    assert suites, "no wired suites parsed from the test script"
    return sum(len(re.findall(r"(?<![\w$.])test\(",
                              (ROOT / rel).read_text(encoding="utf-8")))
               for rel in suites)


def _python_collected_count() -> int:
    """Python ground truth: pytest's OWN collection. A static regex cannot count
    this suite honestly — test_astro_parity.py generates tests dynamically at
    import (globals()[name] = make_test()), so definitions on disk and collected
    tests differ. Collection takes ~1 s and never runs a fixture."""
    proc = subprocess.run([sys.executable, "-m", "pytest", "--collect-only", "-q"],
                          cwd=ROOT / "backend-python", capture_output=True, text=True)
    assert proc.returncode == 0, (proc.stdout[-2000:] + proc.stderr[-2000:])
    m = re.search(r"(\d+) tests? collected", proc.stdout)
    assert m, "pytest --collect-only reported no count:\n" + proc.stdout[-1000:]
    return int(m.group(1))


def test_claimed_test_counts_match_reality_and_every_doc_site():
    """The four claim sites — MASTER-AUDIT's Tests row, BRD O7, BRD NFR-07 and
    the BRD §13 appendix — must all state the SAME Node/Python numbers, and those
    numbers must equal the real suite totals: the Node total over the suites wired
    into npm test, the Python total from pytest's own collection. Counts then can
    never drift again: adding or removing a test without updating every claim in
    the same commit fails CI here."""
    doc = _doc()
    brd = BRD.read_text(encoding="utf-8")

    tests_row = next((ln for ln in doc.splitlines() if ln.startswith("| Tests |")), None)
    assert tests_row, "MASTER-AUDIT must keep its | Tests | inventory row"

    sites: dict[str, tuple[int, int]] = {}

    def site(label: str, node_m, py_m) -> None:
        assert node_m and py_m, (
            f"{label} no longer states both counts (Node/Python) — keep the claim "
            "format so this guard can read it")
        sites[label] = (int(node_m.group(1)), int(py_m.group(1)))

    site("MASTER-AUDIT Tests row",
         re.search(r"\bNode (\d+)", tests_row),
         re.search(r"\bPython (\d+)", tests_row))
    o7 = next((ln for ln in brd.splitlines() if ln.startswith("| O7 |")), None)
    assert o7, "BRD must keep the O7 parity row"
    site("BRD O7", re.search(r"Node (\d+) / Python", o7), re.search(r"/ Python (\d+)", o7))
    nfr = next((ln for ln in brd.splitlines() if ln.startswith("| NFR-07 |")), None)
    assert nfr, "BRD must keep the NFR-07 row"
    site("BRD NFR-07", re.search(r"Node (\d+),", nfr), re.search(r"Python (\d+) tests", nfr))
    site("BRD §13 appendix",
         re.search(r"\*\*Node suite:\*\* (\d+) tests", brd),
         re.search(r"\*\*Python suite:\*\* (\d+) tests", brd))

    node_claims = {v[0] for v in sites.values()}
    py_claims = {v[1] for v in sites.values()}
    assert len(node_claims) == 1, f"the documents disagree on the Node count: {sites}"
    assert len(py_claims) == 1, f"the documents disagree on the Python count: {sites}"
    node_claim, py_claim = node_claims.pop(), py_claims.pop()

    real_node = _node_wired_count()
    assert node_claim == real_node, (
        f"documents claim Node {node_claim}, but the suites wired into npm test define "
        f"{real_node} tests — update the Tests row and all three BRD sites in the same commit")

    real_py = _python_collected_count()
    assert py_claim == real_py, (
        f"documents claim Python {py_claim}, but pytest collects {real_py} tests — "
        "update the Tests row (and its breakdown) and all three BRD sites in the same commit")

    # the Tests row's own itemisation must not lie about this file either
    bd = re.search(r"(\d+) audit-claims", tests_row)
    assert bd, "the Tests row must itemise the audit-claims tests"
    own = len(re.findall(r"^def test_", Path(__file__).read_text(encoding="utf-8"), re.M))
    assert int(bd.group(1)) == own, (
        f"Tests row says {bd.group(1)} audit-claims tests; this file defines {own}")
