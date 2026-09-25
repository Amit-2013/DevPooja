"""Shared helpers: validation, error types, JSON-text parsing, media artifact
naming, magic-byte sniffing.

The magic-byte sniffer is the Python twin of server/lib/upload.js: the
client-controlled Content-Type is only the first filter — the file's actual
leading bytes must match. Fake .jpg files containing HTML/script die here,
exactly as they do in the Node backend."""
import hashlib
import json
import re
import secrets

from fastapi import HTTPException
from PIL import Image

WEBP_SUFFIX = ".webp"
THUMB_SUFFIX = ".t320.jpg"
THUMB_WEBP_SUFFIX = ".t320.webp"

MEDIA_MIME = {"image/jpeg", "image/png", "image/webp"}


def http_error(status: int, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail=message)


def bad(message: str) -> HTTPException:
    return http_error(400, message)


def forbidden(message: str = "Not allowed") -> HTTPException:
    return http_error(403, message)


def not_found(message: str = "Not found") -> HTTPException:
    return http_error(404, message)


def conflict(message: str) -> HTTPException:
    return http_error(409, message)


# --- JSON-text helper (port of lib/util.js j()) ------------------------------
def j(text, default=None):
    """Parse a JSON TEXT column; on any failure return the default."""
    if text is None:
        return default
    if isinstance(text, (dict, list)):
        return text
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return default


# --- validators (port of server/lib/util.js `v`) -----------------------------
def v_str(x, name: str, *, min_len: int = 1, max_len: int = 500, optional: bool = False) -> str:
    if x is None or x == "":
        if optional:
            return ""
        raise bad(f"{name} is required")
    s = str(x).strip()
    if len(s) < min_len:
        raise bad(f"{name} is too short")
    if len(s) > max_len:
        raise bad(f"{name} is too long")
    return s


def v_int(x, name: str, *, min_val: int = -(2**63), max_val: int = 2**63 - 1) -> int:
    try:
        n = int(x)
    except (TypeError, ValueError):
        raise bad(f"{name} is invalid")
    if n < min_val or n > max_val:
        raise bad(f"{name} is invalid")
    return n


def v_mobile(x) -> str:
    s = str(x or "").strip()
    if not re.fullmatch(r"[6-9]\d{9}", s):
        raise bad("Enter a valid 10-digit Indian mobile number")
    return s


def v_email(x) -> str:
    s = str(x or "").strip().lower()
    if not re.fullmatch(r"\S+@\S+\.\S+", s) or len(s) > 120:
        raise bad("Enter a valid email")
    return s


def v_date(x, name: str = "Date") -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(x or "")):
        raise bad(f"{name} is invalid")
    return str(x)


def v_one_of(x, allowed, name: str):
    if x not in allowed:
        raise bad(f"{name} is invalid")
    return x


def v_arr(x, name: str, max_items: int = 20) -> list:
    if x is None:
        return []
    if not isinstance(x, list) or len(x) > max_items:
        raise bad(f"{name} is invalid")
    return x


# --- media helpers -----------------------------------------------------------
def sniff_image(head: bytes) -> str | None:
    """Real content type from leading bytes: JPEG (FF D8 FF), PNG (89 50 4E 47),
    WEBP (RIFF....WEBP). Returns None for anything else — HTML-in-a-.jpg dies."""
    if head[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if head[:4] == b"\x89PNG":
        return "image/png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    return None


def verify_upload(data: bytes, claimed_mime: str) -> str:
    """Returns the verified real MIME type; raises 400 on any mismatch."""
    real = sniff_image(data[:16])
    if not real:
        raise bad("File content does not match its type")
    if claimed_mime and claimed_mime != real:
        raise bad("File content does not match its type")
    return real


def rid(n: int = 8) -> str:
    """Random hex id, same convention as Node's rid()."""
    return secrets.token_hex(n)


def base_name(filename: str) -> str:
    return re.sub(r"\.[a-z0-9]+$", "", filename, flags=re.I)


def variant_names(filename: str, thumb: str | None) -> dict:
    """Server-generated artifact names for one upload (Node mediaVariants convention)."""
    base = base_name(filename)
    names = {"webp": base + WEBP_SUFFIX}
    if thumb:
        names["thumb_webp"] = re.sub(r"\.t320\.jpg$", THUMB_WEBP_SUFFIX, base_name(thumb) + THUMB_SUFFIX, flags=re.I)
    return names


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
