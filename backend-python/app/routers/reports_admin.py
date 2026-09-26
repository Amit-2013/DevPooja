"""Admin export routes — port of GET /admin/export/:report.xlsx and
GET /admin/export-logs from server/routes/admin.js.

Every export requires the admin role, is written to export_logs (admin, report,
filters, row count), and streams a real .xlsx built with openpyxl in the same
professional layout as the Node server. Sensitive fields stay excluded by
design: the report queries never select password hashes, tokens or OTPs."""
import json
import time
from datetime import datetime, timezone
from urllib.parse import quote

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..models import ExportLog, User
from ..security import require_role
from ..services import reports
from ..services.xlsx import build_xlsx
from ..util import http_error

router = APIRouter(prefix="/api/admin", tags=["admin"])
admin_dep = require_role("admin")

REPORT_TITLES = {
    "customers": "Customer", "customer-accounts": "Customer Login / Account",
    "pandit-accounts": "Pandit Login / Account",
    "pandits": "Pandit", "temples": "Temple", "pujas": "Puja",
    "bookings": "Puja Booking", "custom-requests": "Customized Puja Request",
    "kundalis": "Kundali", "kundali-payments": "Kundali Payment",
    "family-members": "Family Member", "samagri": "Samagri Kit",
    "prasad": "Prasad", "orders": "Order", "payments": "Payment",
    "refunds": "Refund", "coupons": "Coupon", "campaigns": "Campaign",
    "payouts": "Pandit Payout", "revenue": "Revenue by Month",
    "commission": "Commission by Month", "puja-performance": "Puja Performance",
    "pandit-performance": "Pandit Performance", "customer-activity": "Customer Activity",
    "login-activity": "Login Activity", "audit-logs": "Audit Log", "media": "Puja Media",
}


@router.get("/export/{report_id}.xlsx")
async def export_report(report_id: str, request: Request,
                        auth: dict = Depends(admin_dep),
                        db: AsyncSession = Depends(get_db)):
    # Node parity: filters are the raw query string, applied inside the reports.
    filters = {k: v for k, v in request.query_params.items() if v}
    data = await reports.report(db, report_id, filters)
    if data is None:
        raise http_error(404, "Unknown report")
    filters_text = "; ".join(f"{k}: {v}" for k, v in filters.items()) or "None"

    xlsx = build_xlsx(report_id, REPORT_TITLES.get(report_id, report_id), data, filters_text)

    db.add(ExportLog(admin_id=auth["uid"], report=report_id,
                     filters=json.dumps(filters), rows=len(data["rows"]),
                     ts=int(time.time() * 1000)))
    await db.flush()

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    filename = quote(f"daivikpooja-{report_id}-{today}.xlsx")
    return Response(
        content=xlsx,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"})


@router.get("/export-logs")
async def export_logs(auth: dict = Depends(admin_dep), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(ExportLog, User.name)
        .join(User, User.id == ExportLog.admin_id, isouter=True)
        .order_by(ExportLog.ts.desc()).limit(100))).all()
    return {"logs": [{
        "id": e.id, "admin": (name or e.admin_id), "report": e.report,
        "filters": e.filters, "rows": e.rows, "ts": e.ts,
    } for e, name in rows]}
