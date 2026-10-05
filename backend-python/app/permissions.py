"""Phase 21 - RBAC permission map (single source for the Python backend).
   Mirrored by server/lib/permissions.js - change both together.

   Role vocabulary (users.role, free TEXT - no schema change):
     customer | pandit   - the two non-privileged portals
     admin               - FULL access to every admin capability
     finance             - the money group only (payouts, commission, ledger,
                           refunds, finance-domain reports + their exports)
     customer_support    - the service group only (bookings, reviews, tickets,
                           incidents, leads, accounts, orders, custom requests,
                           kundali analyses)
   ADMIN_FAMILY = the roles allowed to enter /api/admin at all; admin_access
   answers every admin request from this map. The DEFAULT is admin-only, so a
   new admin route is admin-only until it is deliberately classified here.

   Exports are the most sensitive surface: a pandit or customer never reaches
   the admin router, customer_support never exports, and finance exports only
   the finance-domain reports. """
from fastapi import Depends, Request

from .security import AuthError, current_auth

ADMIN_FAMILY = ("admin", "finance", "customer_support")
# Assignable targets of POST /api/admin/users/{user_id}/role - pandit stays out:
# it is a profile-linked portal role, not an operations seat.
ASSIGNABLE = ("admin", "finance", "customer_support", "customer")

MONEY_PREFIXES = ("/payouts", "/payout-rules", "/commission-tiers", "/ledger")
SUPPORT_PREFIXES = ("/bookings", "/reviews", "/tickets", "/incidents", "/leads",
                    "/accounts", "/users", "/orders", "/custom-requests",
                    "/kundali/analyses")
# Reports finance may read AND export (everything else is admin-only).
FINANCE_REPORTS = ("payments", "payouts", "payout-audit", "dakshina", "transactions",
                   "revenue", "commission", "refunds", "customer-accounts",
                   "pandit-accounts", "coupon-redemptions", "coupon-usage")


def is_family(role: str) -> bool:
    return role in ADMIN_FAMILY


def _hit(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + "/")


def group_for(path: str) -> str:
    """Route path (relative to /api/admin) to capability group. Ordered rules;
    the default keeps unclassified routes admin-only."""
    p = path or "/"
    s = [x for x in p.split("/") if x]
    if p.startswith("/export/"):
        return "export"
    if len(s) == 3 and s[0] == "users" and s[2] == "role":
        return "platform"  # only a full admin hands out seats
    if len(s) == 3 and s[0] == "bookings" and s[2] == "refund":
        return "money"  # money exception in the bookings namespace
    for pre in MONEY_PREFIXES:
        if _hit(p, pre):
            return "money"
    for pre in SUPPORT_PREFIXES:
        if _hit(p, pre):
            return "support"
    return "platform"


def can(role: str, group: str) -> bool:
    """Can this role act on a group? ('export' is answered by can_export)."""
    if role == "admin":
        return True
    if role == "finance":
        return group == "money"
    if role == "customer_support":
        return group == "support"
    return False  # customer / pandit / anything new: never inside the admin API


def can_export(role: str, report_id: str) -> bool:
    if role == "admin":
        return True
    if role == "finance":
        return report_id in FINANCE_REPORTS
    return False


async def admin_access(request: Request, auth: dict = Depends(current_auth)) -> dict:
    """Drop-in replacement for require_role("admin") that ALSO applies the
    Phase 21 permission matrix to every admin route of this router: 401 when
    anonymous, 403 when the role is outside the admin family or outside its
    group. Export paths are checked per report id."""
    if not auth:
        raise AuthError(401, "Please log in")
    if auth["role"] not in ADMIN_FAMILY:
        raise AuthError(403, "Not allowed")
    path = request.url.path
    rel = path[len("/api/admin"):] if path.startswith("/api/admin") else path
    group = group_for(rel)
    if group == "export":
        rid = rel[len("/export/"):]
        if rid.endswith(".xlsx"):
            rid = rid[:-5]
        if not can_export(auth["role"], rid):
            raise AuthError(403, "Not allowed for your role")
    elif not can(auth["role"], group):
        raise AuthError(403, "Not allowed for your role")
    return auth


admin_dep = admin_access
