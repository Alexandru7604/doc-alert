#!/usr/bin/env python3
"""
Wizz price monitor - OTP <-> VLC (3 adulti), via Google Flights.

De ce Google Flights si nu API-ul Wizz direct:
  Wizz / be.wizzair.com e protejat de Kasada (anti-bot JS proof-of-work).
  Un script Python nu poate trece challenge-ul decat cu browser HEADFUL
  (fereastra vizibila). Google Flights nu are Kasada -> merge headless,
  in fundal, programat. Pretul returnat e ACELASI total pe care-l vezi pe
  Wizz (verificat: 1674 RON pentru 3 adulti, zborul W4 OTP->VLC).

Foloseste:
  python wizz_price_monitor.py                # verifica pretul o data, logheaza, alerteaza
  python wizz_price_monitor.py --scan         # scaneaza zile vecine, arata cele mai ieftine
  python wizz_price_monitor.py --threshold 1500   # alerteaza cand total <= 1500 RON

Alerte:
  - mereu: print in consola + linie in price_history.csv
  - toast Windows (best-effort, fara dependinte)
  - email Gmail daca setezi variabilele de mediu:
        set GMAIL_USER=...@gmail.com
        set GMAIL_APP_PASSWORD=parola-de-aplicatie-16-caractere
        set ALERT_TO=...@gmail.com   (optional; default = GMAIL_USER)

Dependinte: pip install playwright fast-flights ; python -m playwright install chromium
"""

import argparse
import csv
import datetime as dt
import os
import smtplib
import subprocess
import sys
import time
import urllib.parse
from email.mime.text import MIMEText
from pathlib import Path

from fast_flights import create_query, FlightQuery, Passengers
from fast_flights.fetcher import URL as GF_URL
from fast_flights.parser import parse
from playwright.sync_api import sync_playwright

# ------------------------- CONFIG zborul tau -------------------------
ORIGIN = "OTP"          # Bucuresti Otopeni
DEST = "VLC"            # Valencia
OUT_DATE = "2026-11-11"  # dus
RET_DATE = "2026-11-14"  # intors
ADULTS = 3
CHILDREN = 0            # 17 ani = tarif adult la Wizz, deci ramane la ADULTS
CURRENCY = "RON"
DEFAULT_THRESHOLD = 1500  # alerteaza cand total <= asta (tinta ta; actual e 1674).
                          # In plus, alerteaza intotdeauna la un minim nou, oricat de mic.

HERE = Path(__file__).resolve().parent
HISTORY = HERE / "price_history.csv"
# --------------------------------------------------------------------


def build_url(out_date: str, ret_date: str) -> str:
    q = create_query(
        flights=[
            FlightQuery(date=out_date, from_airport=ORIGIN, to_airport=DEST, max_stops=0),
            FlightQuery(date=ret_date, from_airport=DEST, to_airport=ORIGIN, max_stops=0),
        ],
        trip="round-trip",
        seat="economy",
        passengers=Passengers(adults=ADULTS, children=CHILDREN),
        currency=CURRENCY,
        language="en-GB",
    )
    return GF_URL + "?" + urllib.parse.urlencode(q.params())


def fetch_html(page, url: str) -> str:
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    time.sleep(3)
    # consimtamant Google (apare prima data)
    for sel in ("button:has-text('Accept all')", "button:has-text('Reject all')",
                "button:has-text('I agree')"):
        try:
            el = page.query_selector(sel)
            if el:
                el.click()
                time.sleep(2)
                break
        except Exception:
            pass
    try:
        page.wait_for_selector("li", timeout=15000)
    except Exception:
        pass
    time.sleep(2)
    return page.content()


def cheapest(url: str, page) -> dict | None:
    """Returneaza dict {price, type, airlines, dep_time} cel mai ieftin Wizz, sau cel mai ieftin in general."""
    html = fetch_html(page, url)
    res = parse(html)
    rows = []
    for f in res:
        try:
            price = int(f.price) if f.price not in (None, "", "Price unavailable") else None
        except (TypeError, ValueError):
            price = None
        if price is None:
            continue
        airlines = getattr(f, "airlines", []) or []
        legs = getattr(f, "flights", []) or [{}]
        leg = legs[0]
        if isinstance(leg, dict):
            dep = leg.get("departure", {}).get("time")
        else:  # dataclass: leg.departure.time
            d = getattr(leg, "departure", None)
            dep = getattr(d, "time", None) if d is not None else None
        rows.append({
            "price": price,
            "type": getattr(f, "type", ""),
            "airlines": airlines,
            "dep_time": dep,
        })
    if not rows:
        return None
    # prefera Wizz (W4) daca exista, altfel cel mai ieftin
    wizz = [r for r in rows if r["type"] == "W4" or any("Wizz" in a for a in r["airlines"])]
    pool = wizz if wizz else rows
    return min(pool, key=lambda r: r["price"])


def log_history(price: int, label: str):
    new = not HISTORY.exists()
    with HISTORY.open("a", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        if new:
            w.writerow(["timestamp", "trip", "price_ron"])
        w.writerow([dt.datetime.now().isoformat(timespec="seconds"), label, price])


def _prices() -> list[int]:
    if not HISTORY.exists():
        return []
    out = []
    with HISTORY.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            try:
                out.append(int(row["price_ron"]))
            except (KeyError, ValueError):
                pass
    return out


def min_seen() -> int | None:
    vals = _prices()
    return min(vals) if vals else None


def last_price() -> int | None:
    vals = _prices()
    return vals[-1] if vals else None


def toast(title: str, body: str):
    """Toast Windows non-blocant, best-effort."""
    ps = f'''
$ErrorActionPreference='SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null
$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x=$t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode("{title}"))|Out-Null
$x.Item(1).AppendChild($t.CreateTextNode("{body}"))|Out-Null
$toast=[Windows.UI.Notifications.ToastNotification]::new($t)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("WizzMonitor").Show($toast)
'''
    try:
        subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                       timeout=15, capture_output=True)
    except Exception:
        pass


def email_alert(subject: str, body: str):
    user = os.environ.get("GMAIL_USER")
    pwd = os.environ.get("GMAIL_APP_PASSWORD")
    to = os.environ.get("ALERT_TO", user)
    if not (user and pwd and to):
        return False
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = user
    msg["To"] = to
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as s:
            s.login(user, pwd)
            s.sendmail(user, [to], msg.as_string())
        return True
    except Exception as e:
        print(f"[email esuat] {e}")
        return False


def push_ntfy(title: str, body: str, buy: bool):
    """Push instant pe telefon via ntfy.sh. Seteaza env NTFY_TOPIC.
    Pe telefon: instaleaza app 'ntfy' (Android/iOS), aboneaza-te la acelasi topic."""
    import urllib.request
    topic = os.environ.get("NTFY_TOPIC")
    if not topic:
        return False
    url = topic if topic.startswith("http") else "https://ntfy.sh/" + topic
    headers = {
        "Title": title.encode("utf-8"),
        "Priority": "urgent" if buy else "default",
        "Tags": "airplane,money" if buy else "airplane",
        "Click": "https://www.google.com/travel/flights",
    }
    try:
        req = urllib.request.Request(url, data=body.encode("utf-8"), headers=headers)
        urllib.request.urlopen(req, timeout=20)
        return True
    except Exception as e:
        print(f"[ntfy esuat] {e}")
        return False


def run_monitor(threshold: int):
    label = f"{ORIGIN}-{DEST} {OUT_DATE}/{RET_DATE} {ADULTS}pax"
    url = build_url(OUT_DATE, RET_DATE)
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(locale="en-GB", user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"))
        page = ctx.new_page()
        best = cheapest(url, page)
        b.close()

    if not best:
        print("Nu am putut citi pretul (Google a schimbat pagina sau nicio cursa directa).")
        return 2

    price = best["price"]
    prev_min = min_seen()       # cel mai mic vazut vreodata (inainte de a loga acum)
    prev_price = last_price()   # pretul de la rularea anterioara
    log_history(price, label)
    dep = best["dep_time"]
    dep_s = f"{dep[0]:02d}:{dep[1]:02d}" if dep else "?"
    line = (f"{label}: {price} {CURRENCY}  ({'Wizz' if best['type']=='W4' else best['airlines']}, "
            f"dus {dep_s})")
    print(line)
    if prev_min is not None:
        print(f"minim vazut anterior: {prev_min} {CURRENCY}")

    # Semnal de CUMPARARE: minim nou (mai ieftin ca oricand). Asta e momentul de actiune.
    new_low = prev_min is None or price < prev_min
    # Tinta atinsa: sub prag, dar trimite o data la traversare (nu spam cat sta sub prag).
    crossed_target = price <= threshold and (prev_price is None or prev_price > threshold)

    if not (new_low or crossed_target):
        return 0

    buy = new_low or crossed_target
    reason = "MINIM NOU" if new_low else "sub prag"
    drop = f" (anterior {prev_min} {CURRENCY})" if (new_low and prev_min is not None) else ""
    title = f"CUMPARA: Wizz {ORIGIN}-{DEST} {price} {CURRENCY}"
    body = (f"{line}\n{reason}{drop}. Prag {threshold}.\n"
            f"Cumpara pe app/site Wizz ACUM: wizzair.com\n"
            f"{dt.datetime.now().strftime('%d %b %H:%M')}")
    push_ntfy(title, body, buy)   # push instant pe telefon (canalul real la 03:00)
    email_alert(title, body)      # backup email
    toast(title, body)            # toast PC (cand esti la birou)
    print(f">>> ALERTA ({reason}) -> push+email trimise")
    return 0


def run_scan(threshold: int):
    """Scaneaza combinatii de zile in jurul datelor tale -> cele mai ieftine."""
    out0 = dt.date.fromisoformat(OUT_DATE)
    ret0 = dt.date.fromisoformat(RET_DATE)
    deltas = (-3, -2, -1, 0, 1, 2, 3)
    combos = []
    for do in deltas:
        for dr in deltas:
            od = out0 + dt.timedelta(days=do)
            rd = ret0 + dt.timedelta(days=dr)
            if rd <= od:
                continue
            combos.append((od.isoformat(), rd.isoformat()))

    print(f"Scanez {len(combos)} combinatii dus/intors (+/-3 zile)...\n")
    results = []
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(locale="en-GB", user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"))
        page = ctx.new_page()
        for od, rd in combos:
            try:
                best = cheapest(build_url(od, rd), page)
            except Exception as e:
                best = None
            if best:
                wd_o = dt.date.fromisoformat(od).strftime("%a")
                wd_r = dt.date.fromisoformat(rd).strftime("%a")
                results.append((best["price"], od, wd_o, rd, wd_r, best["type"]))
                print(f"  {od} ({wd_o}) -> {rd} ({wd_r}): {best['price']} {CURRENCY}")
            time.sleep(1.5)
        b.close()

    if not results:
        print("Nimic gasit.")
        return 2
    results.sort()
    print("\n=== TOP 8 cele mai ieftine ===")
    for price, od, wo, rd, wr, typ in results[:8]:
        tag = "Wizz" if typ == "W4" else typ
        print(f"  {price} {CURRENCY}  {od} {wo} -> {rd} {wr}  [{tag}]")
    cheapest_total = results[0][0]
    print(f"\nReferinta ta ({OUT_DATE}->{RET_DATE}): vezi --scan de sus.")
    print(f"Cel mai ieftin gasit: {cheapest_total} {CURRENCY}")
    return 0


def main():
    ap = argparse.ArgumentParser(description="Monitor pret zbor Wizz OTP-VLC (via Google Flights)")
    ap.add_argument("--scan", action="store_true", help="scaneaza zile vecine pentru cel mai ieftin")
    ap.add_argument("--threshold", type=int, default=DEFAULT_THRESHOLD,
                    help=f"prag alerta in {CURRENCY} (default {DEFAULT_THRESHOLD})")
    args = ap.parse_args()
    # consola UTF-8 (diacritice / nume aeroporturi)
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if args.scan:
        return run_scan(args.threshold)
    return run_monitor(args.threshold)


if __name__ == "__main__":
    raise SystemExit(main())
