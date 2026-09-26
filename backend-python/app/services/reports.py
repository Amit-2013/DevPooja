"""Admin Excel exports — port of the REPORTS registry in server/routes/admin.js,
using openpyxl for the workbook build.

One route, many report ids. Each report function returns {columns, rows} built
from the same queries the admin pages use (single source of truth), with
sensitive fields (password hashes, OTPs, tokens, KYC) excluded by design.
Filters come from the query string and are applied inside the report functions.

Portability note: Node's SQL uses SQLite-only json_extract() over the pay/q JSON
columns. Here the equivalent JSON columns are parsed in Python (util.j), so the
same queries run on SQLite (dev/tests) and Postgres (Render/Supabase)."""
import json

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..util import j

# Money-like header detection (Node parity): columns whose header matches get the
# Indian-currency number format and a totals-row entry.
import re

_MONEY = re.compile(r"rs|amount|price|total|gst|spent|value|revenue|commission|earning|payout|refund|budget|quote|offering", re.I)


def is_money_column(header) -> bool:
    return bool(_MONEY.search(str(header or "")))


def _q_total(row) -> int:
    return int((j(row.q, {}).get("total")) or 0)


def _pay(row) -> dict:
    return j(row.pay, {})


def _refund(row) -> dict:
    return j(row.refund, {}) if row.refund else {}


def _ms_to_sqlite_dt(ms) -> str:
    """datetime(ms/1000,'unixepoch') parity: 'YYYY-MM-DD HH:MM:SS' in UTC."""
    import datetime as _dt
    if not ms:
        return ""
    return _dt.datetime.fromtimestamp(ms / 1000, tz=_dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


async def _all(db: AsyncSession, sql: str, params: dict | None = None):
    res = await db.execute(text(sql), params or {})
    return res.mappings().all()


# --- shared filter builders (Node parity) --------------------------------------
def booking_filter(f: dict) -> tuple[str, dict]:
    w = ["b.status != 'PendingPayment'"]
    p: dict = {}
    if f.get("status"):
        w.append("b.status = :status")
        p["status"] = str(f["status"])
    if f.get("from"):
        w.append("b.date >= :from")
        p["from"] = str(f["from"])
    if f.get("to"):
        w.append("b.date <= :to")
        p["to"] = str(f["to"])
    if f.get("mode"):
        w.append("b.mode = :mode")
        p["mode"] = str(f["mode"])
    return (" WHERE " + " AND ".join(w), p) if w else ("", p)


def kundali_filter(f: dict) -> tuple[str, dict]:
    w, p = [], {}
    if f.get("billing"):
        w.append("k.billing = :billing")
        p["billing"] = str(f["billing"])
    if f.get("from"):
        w.append("substr(k.created_at, 1, 10) >= :from")
        p["from"] = str(f["from"])
    if f.get("to"):
        w.append("substr(k.created_at, 1, 10) <= :to")
        p["to"] = str(f["to"])
    return (" WHERE " + " AND ".join(w), p) if w else ("", p)


# --- the 27 reports (same ids, columns and row shapes as Node) ------------------
async def report(db: AsyncSession, report_id: str, f: dict) -> dict | None:
    """Returns {columns, rows} or None when the id is unknown (route 404s)."""
    bfp, bfw = None, None  # lazily built booking/kundali filters per report

    if report_id == "customers":
        rows = await _all(db, "SELECT id, name, mobile, email, plus, pts, joined FROM users WHERE role='customer' ORDER BY id")
        return {"columns": ["ID", "Name", "Mobile", "Email", "Plus member", "Points", "Joined"],
                "rows": [[r.id, r.name, r.mobile, r.email, r.plus, r.pts, r.joined] for r in rows]}

    if report_id == "pandits":
        rows = await _all(db, "SELECT p.id, p.name, p.city, p.exp, p.rating, p.rev, p.status, p.featured, u.mobile AS umobile FROM pandits p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.id")
        return {"columns": ["ID", "Name", "City", "Experience (yrs)", "Rating", "Reviews", "KYC status", "Featured", "Mobile"],
                "rows": [[r.id, r.name, r.city, r.exp, r.rating, r.rev, r.status, r.featured, r.umobile] for r in rows]}

    if report_id == "temples":
        rows = await _all(db, "SELECT id, name, city, deity, offering, descr FROM temples ORDER BY id")
        return {"columns": ["ID", "Name", "City", "Deity", "Offering (Rs)", "Description"],
                "rows": [[r.id, r.name, r.city, r.deity, r.offering, r.descr] for r in rows]}

    if report_id == "pujas":
        rows = await _all(db, "SELECT id, name, hindi, cat, price, dur, deity, hidden, pop FROM pujas ORDER BY id")
        return {"columns": ["ID", "Name", "Hindi name", "Category", "Price (Rs)", "Duration (min)", "Deity", "Hidden", "Popularity"],
                "rows": [[r.id, r.name, r.hindi, r.cat, r.price, r.dur, r.deity, r.hidden, r.pop] for r in rows]}

    if report_id == "bookings":
        where, params = booking_filter(f)
        rows = await _all(db, "SELECT b.*, u.name AS customer, u.mobile AS umobile FROM bookings b LEFT JOIN users u ON u.id=b.user_id" + where + " ORDER BY b.created DESC", params)
        return {"columns": ["Booking ID", "Customer", "Mobile", "Puja", "Mode", "Date", "Slot", "Status", "Total (Rs)", "Coupon"],
                "rows": [[r.id, r.customer, r.umobile, r.puja_id, r.mode, r.date, r.slot, r.status, _q_total(r), r.coupon] for r in rows]}

    if report_id == "payments":
        where, params = booking_filter(f)
        extra = " AND " if where else " WHERE "
        rows = await _all(db, "SELECT b.*, u.name AS customer FROM bookings b LEFT JOIN users u ON u.id=b.user_id" + where + extra + "1=1 ORDER BY b.created DESC", params)
        rows = [r for r in rows if _pay(r).get("paid")]
        return {"columns": ["Booking ID", "Customer", "Puja", "Date", "Method", "Reference", "Amount (Rs)", "Booking status"],
                "rows": [[r.id, r.customer, r.puja_id, r.date, _pay(r).get("method"), _pay(r).get("ref"), _q_total(r), r.status] for r in rows]}

    if report_id == "orders":
        rows = await _all(db, "SELECT o.*, u.name AS customer FROM orders o LEFT JOIN users u ON u.id=o.user_id ORDER BY o.date DESC")
        return {"columns": ["Order ID", "Customer", "Total (Rs)", "Date", "Status", "City"],
                "rows": [[r.id, r.customer, r.total, r.date, r.status, r.city] for r in rows]}

    if report_id == "kundalis":
        where, params = kundali_filter(f)
        rows = await _all(db, "SELECT k.*, u.name AS customer, u.mobile AS umobile FROM kundalis k LEFT JOIN users u ON u.id=k.customer_id" + where + " ORDER BY k.created_at DESC", params)
        return {"columns": ["Kundali ID", "Name", "Customer", "Mobile", "Relationship", "Billing", "Price (Rs)", "Discount (Rs)", "GST (Rs)", "Final (Rs)", "Currency", "Payment status", "Order ID", "Created"],
                "rows": [[r.id, r.name, r.customer or "", r.umobile or "", r.relationship or "Self", r.billing, r.price, r.discount, r.gst, r.final_amount, r.currency, r.payment_status, r.order_id, r.created_at] for r in rows]}

    if report_id == "kundali-payments":
        where, params = kundali_filter(f)
        w = where + (" AND k.billing IN ('PAID','PENDING_PAYMENT','REFUNDED')" if where
                     else " WHERE k.billing IN ('PAID','PENDING_PAYMENT','REFUNDED')")
        rows = await _all(db, "SELECT k.*, u.name AS customer FROM kundalis k LEFT JOIN users u ON u.id=k.customer_id" + w + " ORDER BY k.created_at DESC", params)
        return {"columns": ["Kundali ID", "Customer", "Amount (Rs)", "Currency", "Payment status", "Order ID", "Payment ID", "Created"],
                "rows": [[r.id, r.customer or "", r.final_amount, r.currency, r.payment_status, r.order_id, r.payment_id, r.created_at] for r in rows]}

    if report_id == "family-members":
        rows = await _all(db, "SELECT f.*, u.name AS customer FROM family_members f LEFT JOIN users u ON u.id=f.customer_id ORDER BY f.created_at")
        return {"columns": ["Member ID", "Customer", "Relationship", "Name", "Gender", "DOB", "TOB", "City", "State", "Country"],
                "rows": [[r.id, r.customer or "", r.relationship, r.name, r.gender, r.dob, r.tob, r.city, r.state, r.country] for r in rows]}

    if report_id == "custom-requests":
        w, p = [], {}
        if f.get("status"):
            w.append("c.status = :status")
            p["status"] = str(f["status"])
        if f.get("q"):
            like = "%" + str(f["q"]).replace("%", "").replace("_", "") + "%"
            w.append("(c.name LIKE :q OR c.mobile LIKE :q OR c.id LIKE :q)")
            p["q"] = like
        sql = ("SELECT c.*, u.name AS customer FROM custom_requests c LEFT JOIN users u ON u.id=c.user_id"
               + (" WHERE " + " AND ".join(w) if w else "")
               + " ORDER BY c.created_at DESC")
        rows = await _all(db, sql, p)
        return {"columns": ["Request ID", "Name", "Mobile", "Purpose", "Deity", "Occasion", "Preferred date", "City", "Budget (Rs)", "Kundali ID", "Dosh", "Assigned pandit", "Quote (Rs)", "Final price (Rs)", "Payment status", "Status", "Created", "Updated"],
                "rows": [[r.id, r.name, r.mobile, r.purpose, r.deity, r.occasion, r.preferred_date, r.city, r.budget,
                          r.kundali_id, r.dosh_condition, r.assigned_pandit_id, r.quote_amount, r.final_price,
                          r.payment_status, r.status, r.created_at, r.updated_at] for r in rows]}

    if report_id == "samagri":
        rows = await _all(db, "SELECT id, name, price, stock, active FROM kits ORDER BY id")
        return {"columns": ["Kit ID", "Name", "Price (Rs)", "Stock", "Active"],
                "rows": [[r.id, r.name, r.price, r.stock, r.active] for r in rows]}

    if report_id == "prasad":
        rows = await _all(db, "SELECT id, name, price, stock, active FROM prasad ORDER BY id")
        return {"columns": ["ID", "Name", "Price (Rs)", "Stock", "Active"],
                "rows": [[r.id, r.name, r.price, r.stock, r.active] for r in rows]}

    if report_id == "coupons":
        rows = await _all(db, "SELECT code, type, val, max, min, active, used FROM coupons ORDER BY code")
        return {"columns": ["Code", "Type", "Value", "Max (Rs)", "Min order (Rs)", "Active", "Times used"],
                "rows": [[r.code, r.type, r.val, r.max, r.min, r.active, r.used] for r in rows]}

    if report_id == "campaigns":
        rows = await _all(db, "SELECT id, name, channel, audience, status, sent FROM campaigns ORDER BY id")
        return {"columns": ["ID", "Name", "Channel", "Audience", "Status", "Sent"],
                "rows": [[r.id, r.name, r.channel, r.audience, r.status, r.sent] for r in rows]}

    if report_id == "payouts":
        rows = await _all(db, "SELECT po.*, p.name AS pandit FROM payouts po LEFT JOIN pandits p ON p.id=po.pandit_id ORDER BY po.date DESC")
        return {"columns": ["Payout ID", "Pandit", "Net (Rs)", "Date", "Status", "Booking ID", "Gross (Rs)", "Commission (Rs)", "Tax (Rs)", "Refund (Rs)", "Adjustment (Rs)", "Hold reason", "Processing date", "Disbursement date", "Payment ref", "UTR"],
                "rows": [[r.id, r.pandit or "", r.amount, r.date, r.status, r.booking_id,
                          r.gross_amount if r.gross_amount is not None else r.amount,
                          r.commission_amt, r.tax_amt, r.refund_amt, r.adjustment_amt,
                          r.hold_reason or "", r.processing_date or "", r.disbursement_date or "",
                          r.payment_ref or "", r.utr or ""] for r in rows]}

    if report_id == "payout-audit":
        rows = await _all(db, "SELECT po.* FROM payouts po ORDER BY po.date DESC")
        return {"columns": ["Payout ID", "Pandit ID", "Net (Rs)", "Status", "Hold reason", "Hold note", "Processing date", "Disbursement date", "Payment ref", "UTR"],
                "rows": [[r.id, r.pandit_id or "", r.amount, r.status, r.hold_reason or "",
                          r.hold_note or "", r.processing_date or "", r.disbursement_date or "",
                          r.payment_ref or "", r.utr or ""] for r in rows]}

    if report_id == "revenue":
        rows = await _all(db, "SELECT substr(b.date, 1, 7) AS ym, COUNT(*) AS n, b.pay, b.q FROM bookings b GROUP BY ym ORDER BY ym DESC")
        agg: dict = {}
        for r in rows:
            if not _pay(r).get("paid"):
                continue
            k = r.ym
            if k not in agg:
                agg[k] = [0, 0]
            agg[k][0] += 1
            agg[k][1] += _q_total(r)
        return {"columns": ["Month", "Paid bookings", "Revenue (Rs)"],
                "rows": [[k, v[0], v[1]] for k, v in sorted(agg.items(), reverse=True)]}

    if report_id == "puja-performance":
        rows = await _all(db, "SELECT p.name AS pname, b.mode, b.pay, b.q, b.status FROM bookings b JOIN pujas p ON p.id=b.puja_id")
        agg: dict = {}
        for r in rows:
            if r.status == "Cancelled":
                continue
            key = (r.pname, r.mode)
            if key not in agg:
                agg[key] = [0, 0]
            agg[key][0] += 1
            agg[key][1] += _q_total(r)
        out = [[k[0], k[1], v[0], v[1]] for k, v in agg.items()]
        out.sort(key=lambda x: -x[3])
        return {"columns": ["Puja", "Mode", "Bookings", "Value (Rs)"], "rows": out}

    if report_id == "commission":
        setting = (await _all(db, "SELECT value FROM settings WHERE key='commission'"))
        pct = j(setting[0].value, 20) if setting else 20
        rows = await _all(db, "SELECT substr(b.date, 1, 7) AS ym, b.pay, b.q, b.status FROM bookings b GROUP BY ym")
        agg: dict = {}
        for r in rows:
            if not _pay(r).get("paid") or r.status == "Cancelled":
                continue
            k = r.ym
            if k not in agg:
                agg[k] = 0
            agg[k] += _q_total(r)
        return {"columns": ["Month", "Platform commission (Rs)"],
                "rows": [[k, round(v * pct / 100)] for k, v in sorted(agg.items(), reverse=True)]}

    if report_id == "customer-accounts":
        rows = await _all(db, """
            SELECT u.*,
              (SELECT COUNT(*) FROM bookings b WHERE b.user_id=u.id) AS bookings,
              (SELECT COUNT(*) FROM kundalis k WHERE k.customer_id=u.id) AS kundalis,
              (SELECT COUNT(*) FROM family_members f WHERE f.customer_id=u.id) AS family
            FROM users u WHERE u.role='customer' ORDER BY u.created_at DESC""")
        return {"columns": ["ID", "Name", "Mobile", "Email", "Login ID", "Login method", "Status", "Joined", "Last login", "Last method", "Bookings", "Kundalis", "Family members"],
                "rows": [[r.id, r.name, r.mobile or "", r.email or "",
                          (r.email or "") if (r.email not in (None, "")) else (r.mobile or ""),
                          "email" if (r.email not in (None, "")) else "mobile",
                          r.status or "active", r.joined or "",
                          _ms_to_sqlite_dt(r.last_login_at), r.last_login_method or "",
                          r.bookings, r.kundalis, r.family] for r in rows]}

    if report_id == "pandit-accounts":
        rows = await _all(db, """
            SELECT p.*, u.email AS uemail, u.mobile AS umobile, u.status AS ustatus, u.joined AS ujoined, u.last_login_at AS ulast,
              (SELECT COUNT(*) FROM bookings b WHERE b.pandit_id=p.id) AS assigned,
              (SELECT COUNT(*) FROM bookings b WHERE b.pandit_id=p.id AND b.status='Completed') AS completed
            FROM pandits p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.id""")
        return {"columns": ["Pandit ID", "Name", "Mobile (login ID)", "Email", "KYC verified", "Account status", "Joined", "Last login", "Assigned bookings", "Completed"],
                "rows": [[r.id, r.name, r.mobile or r.umobile or "", r.uemail or "",
                          "Yes" if r.status == "verified" else "No", r.ustatus or "active",
                          r.ujoined or "", _ms_to_sqlite_dt(r.ulast), r.assigned, r.completed] for r in rows]}

    if report_id == "refunds":
        where, params = booking_filter(f)
        extra = " AND b.refund IS NOT NULL" if where else " WHERE b.refund IS NOT NULL"
        rows = await _all(db, "SELECT b.*, u.name AS customer FROM bookings b LEFT JOIN users u ON u.id=b.user_id" + where + extra + " ORDER BY b.created DESC", params)
        return {"columns": ["Booking", "Customer", "Puja", "Date", "Amount (Rs)", "State", "Reason"],
                "rows": [[r.id, r.customer or "", r.puja_id, r.date, _refund(r).get("amt"),
                          _refund(r).get("state"), _refund(r).get("reason")] for r in rows]}

    if report_id == "pandit-performance":
        rows = await _all(db, """
            SELECT p.*, 
              (SELECT COUNT(*) FROM bookings b WHERE b.pandit_id=p.id) AS assigned,
              (SELECT COUNT(*) FROM bookings b WHERE b.pandit_id=p.id AND b.status='Completed') AS completed
            FROM pandits p ORDER BY p.name""")
        # Node sums json_extract(b.q,'$.svc') over completed bookings; parse in
        # Python so the query stays portable across SQLite and Postgres.
        svc_rows = await _all(db, "SELECT pandit_id, q FROM bookings WHERE status='Completed'")
        svc_by_pandit: dict = {}
        for b in svc_rows:
            svc_by_pandit[b.pandit_id] = svc_by_pandit.get(b.pandit_id, 0) + int((j(b.q, {}).get("svc")) or 0)
        return {"columns": ["Pandit", "City", "Rating", "Assigned", "Completed", "Service value (Rs)"],
                "rows": [[r.name, r.city, r.rating, r.assigned, r.completed,
                          svc_by_pandit.get(r.id, 0)] for r in rows]}

    if report_id == "customer-activity":
        rows = await _all(db, """
            SELECT u.*,
              (SELECT COUNT(*) FROM bookings b WHERE b.user_id=u.id) AS bookings,
              (SELECT COALESCE(MAX(b.date), '') FROM bookings b WHERE b.user_id=u.id) AS last_booking
            FROM users u WHERE u.role='customer'""")
        out = []
        for r in rows:
            paid = 0
            brows = await _all(db, "SELECT b.pay, b.q, b.user_id FROM bookings b WHERE b.user_id = :uid", {"uid": r.id})
            for b in brows:
                if _pay(b).get("paid"):
                    paid += _q_total(b)
            kcount = (await _all(db, "SELECT COUNT(*) AS n FROM kundalis k WHERE k.customer_id = :uid", {"uid": r.id}))[0].n
            out.append([r.id, r.name, r.mobile or "", r.bookings, paid, r.last_booking, kcount])
        out.sort(key=lambda x: -x[4])
        return {"columns": ["Customer ID", "Name", "Mobile", "Bookings", "Total spent (Rs)", "Last booking", "Kundalis"], "rows": out}

    if report_id == "login-activity":
        w, p = [], {}
        if f.get("status") == "failed":
            w.append("l.ok = 0")
        if f.get("status") == "success":
            w.append("l.ok = 1")
        if f.get("from"):
            w.append("l.ts >= :from")
            p["from"] = _day_start_ms(f.get("from"))
        if f.get("to"):
            w.append("l.ts <= :to")
            p["to"] = _day_end_ms(f.get("to"))
        rows = await _all(db, "SELECT l.*, u.name AS uname, u.role AS urole FROM login_activity l LEFT JOIN users u ON u.id=l.user_id"
                          + (" WHERE " + " AND ".join(w) if w else "")
                          + " ORDER BY l.ts DESC LIMIT 2000", p)
        return {"columns": ["User", "Role", "Method", "Outcome", "Reason", "IP", "When"],
                "rows": [[r.uname or "", r.urole or "", r.method,
                          "Success" if r.ok == 1 else "Failed", r.reason, r.ip,
                          _ms_to_sqlite_dt(r.ts)] for r in rows]}

    if report_id == "audit-logs":
        w, p = [], {}
        if f.get("action"):
            w.append("a.action = :action")
            p["action"] = str(f["action"])
        if f.get("from"):
            w.append("a.created_at >= :from")
            p["from"] = _day_start_ms(f.get("from"))
        if f.get("to"):
            w.append("a.created_at <= :to")
            p["to"] = _day_end_ms(f.get("to"))
        rows = await _all(db, "SELECT a.*, u.name AS uname FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id"
                          + (" WHERE " + " AND ".join(w) if w else "")
                          + " ORDER BY a.id DESC LIMIT 2000", p)
        return {"columns": ["When", "Actor", "Role", "Action", "Entity", "Entity ID", "Detail"],
                "rows": [[_ms_to_sqlite_dt(r.created_at), r.uname or r.actor_user_id or "", r.actor_role,
                          r.action, r.entity, r.entity_id, j(r.detail, {})] for r in rows]}

    if report_id == "media":
        w, p = [], {}
        if f.get("status"):
            w.append("m.status = :status")
            p["status"] = str(f["status"])
        sql = ("SELECT m.*, p.name AS puja, pd.name AS pandit FROM puja_media m "
               "LEFT JOIN pujas p ON p.id=m.puja_id LEFT JOIN pandits pd ON pd.id=m.pandit_id"
               + (" WHERE " + " AND ".join(w) if w else "")
               + " ORDER BY m.created_at DESC")
        rows = await _all(db, sql, p)
        return {"columns": ["Media ID", "Puja", "Booking", "Pandit", "Original name", "MIME", "Size (bytes)", "Status", "Primary", "Published", "Uploaded"],
                "rows": [[r.id, r.puja or "", r.booking_id or "", r.pandit or "", r.orig_name, r.mime, r.size,
                          r.status, 1 if r.is_primary == 1 else 0, 1 if r.is_published == 1 else 0,
                          _ms_to_sqlite_dt(r.created_at)] for r in rows]}

    return None


def _day_start_ms(day: str) -> int:
    import datetime as _dt
    d = _dt.datetime.strptime(str(day), "%Y-%m-%d").replace(tzinfo=_dt.timezone.utc)
    return int(d.timestamp() * 1000)


def _day_end_ms(day: str) -> int:
    import datetime as _dt
    d = _dt.datetime.strptime(str(day), "%Y-%m-%d").replace(tzinfo=_dt.timezone.utc)
    return int(d.timestamp() * 1000) + 86399999
