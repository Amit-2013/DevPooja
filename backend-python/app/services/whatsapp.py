"""WhatsApp provider adapter for the comms engine — "a stub behind env config".
Python twin of server/services/whatsapp.js.

WHATSAPP_PROVIDER picks the transport:

  stub   (default)  accepts every message, NEVER contacts a network — so the
                    demo, tests and a fresh clone are safe by construction;
  twilio            real send through the Twilio WhatsApp API
                    (TWILIO_SID / TWILIO_TOKEN / TWILIO_WA_FROM);
  none / off        disabled: the in-app row still lands, nothing is sent.

The returned string is written to the delivery record's detail column, so the
campaign detail table shows exactly what the adapter did ("stub accepted ...",
"disabled ..."). Unlike Node (fire-and-forget, delivery row updated when the
request settles), deliver() here is async, so a twilio send is awaited inline
and the final result lands in the same record directly.
"""
import os

_stub_seq = 0


def provider() -> str:
    return (os.environ.get("WHATSAPP_PROVIDER", "stub") or "stub").strip().lower()


async def send_whatsapp(*, to: str | None, message: str) -> str:
    """Send one WhatsApp message through the configured adapter and return the
    adapter result string for the delivery record's detail column."""
    global _stub_seq
    p = provider()
    if p == "stub":
        _stub_seq += 1
        return (f"whatsapp stub accepted message stub-{_stub_seq} "
                f"(WHATSAPP_PROVIDER=stub, nothing sent)")
    if p in ("none", "off"):
        return f"whatsapp adapter disabled (WHATSAPP_PROVIDER={p})"
    if p == "twilio":
        sid = os.environ.get("TWILIO_SID")
        tok = os.environ.get("TWILIO_TOKEN")
        frm = os.environ.get("TWILIO_WA_FROM")
        if not (sid and tok and frm):
            return "twilio adapter not configured (TWILIO_SID / TWILIO_TOKEN / TWILIO_WA_FROM missing)"
        num = str(to or "")
        dest = "whatsapp:" + (num if num.startswith("+") else "+91" + num)
        src = frm if frm.startswith("whatsapp:") else "whatsapp:" + frm
        try:
            import httpx
            r = await httpx.post(
                f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
                auth=(sid, tok), data={"To": dest, "From": src, "Body": message},
                timeout=10.0)
            if r.status_code < 400:
                return f"twilio adapter sent ({dest})"
            return f"twilio adapter failed (HTTP {r.status_code})"
        except Exception as e:  # network/provider errors never abort the send
            return f"twilio adapter error: {e}"
    return f'unknown WHATSAPP_PROVIDER "{p}" — message not sent'
