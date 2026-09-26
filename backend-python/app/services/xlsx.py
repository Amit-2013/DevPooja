"""openpyxl workbook builder — port of the exceljs formatting block in
server/routes/admin.js (GET /admin/export/:report.xlsx): report title, generated-on
(IST, 12-hour), applied filters, frozen + filterable header row, auto column
widths, Indian-currency number formats, and a totals row where useful."""
import io
from datetime import datetime, timezone, timedelta

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from .reports import is_money_column

TEAL = "FF0C4B49"
GREY = "FF6B7280"

# en-IN 12-hour clock, e.g. '26-09-2026, 11:42:07 am' (Node toLocaleString('en-IN'))
_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _ist_now_string() -> str:
    ist = timezone(timedelta(hours=5, minutes=30))
    now = datetime.now(ist)
    h = now.hour % 12 or 12
    ampm = "am" if now.hour < 12 else "pm"
    return f"{now.day:02d}-{_MONTHS[now.month - 1]}-{now.year}, {h:02d}:{now.minute:02d}:{now.second:02d} {ampm}"


def build_xlsx(report_id: str, title: str, data: dict, filters_text: str) -> bytes:
    """Renders {columns, rows} into the professional .xlsx layout as bytes."""
    wb = Workbook()
    ws = wb.active
    ws.title = str(report_id)[:28]
    ws.freeze_panes = "A5"  # exceljs views: [{ state: 'frozen', ySplit: 4 }]

    ncols = max(len(data["columns"]), 1)
    filters = filters_text or "None"

    # 1: title
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=ncols)
    t1 = ws.cell(row=1, column=1)
    t1.value = "DaivikPooja \u2014 " + (title or report_id) + " Report"
    t1.font = Font(bold=True, size=14, color=TEAL)

    # 2: generated on (IST) + row count
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=ncols)
    t2 = ws.cell(row=2, column=1)
    t2.value = "Generated on: " + _ist_now_string() + " IST    |    Rows: " + str(len(data["rows"]))
    t2.font = Font(size=10, color=GREY)

    # 3: applied filters
    ws.merge_cells(start_row=3, start_column=1, end_row=3, end_column=ncols)
    t3 = ws.cell(row=3, column=1)
    t3.value = "Filters: " + filters
    t3.font = Font(size=10, italic=True, color=GREY)

    # 4: header row (white bold on teal, wrapped)
    hr = 4
    for i, h in enumerate(data["columns"], start=1):
        c = ws.cell(row=hr, column=i)
        c.value = h
        c.font = Font(bold=True, color="FFFFFFFF")
        c.fill = PatternFill("solid", fgColor=TEAL)
        c.alignment = Alignment(vertical="center", wrap_text=True)
    ws.row_dimensions[hr].height = 20

    is_num = [is_money_column(h) for h in data["columns"]]

    # data rows with Indian-currency number formats on money-like columns
    for r in data["rows"]:
        row_idx = ws.max_row + 1
        for i, cell in enumerate(r, start=1):
            c = ws.cell(row=row_idx, column=i)
            c.value = cell
            if is_num[i - 1] and isinstance(cell, (int, float)):
                c.number_format = "#,##0"

    # totals row when there is more than one data row (Node parity)
    if len(data["rows"]) > 2:
        totals = []
        for i, h in enumerate(data["columns"]):
            if not is_num[i]:
                totals.append("Total" if i == 0 else "")
            else:
                s = sum(r[i] for r in data["rows"] if isinstance(r[i], (int, float)))
                totals.append(s if s else "")
        row_idx = ws.max_row + 1
        for i, v in enumerate(totals, start=1):
            c = ws.cell(row=row_idx, column=i)
            c.value = v
            c.font = Font(bold=True)
            if is_num[i - 1] and isinstance(v, (int, float)):
                c.number_format = "#,##0"

    # auto column widths, capped like Node (10..42)
    for i, h in enumerate(data["columns"], start=1):
        w = len(str(h or "")) + 2
        for r in data["rows"]:
            w = max(w, len(str(r[i - 1] if r[i - 1] is not None else "")) + 2)
        ws.column_dimensions[get_column_letter(i)].width = min(42, max(10, w))

    if ncols > 1 and data["rows"]:
        ws.auto_filter.ref = f"A4:{get_column_letter(ncols)}4"

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
