#!/usr/bin/env python3
"""
Turn a saved copy of the [un]prompted agenda page into data/agenda.json.

Usage:
    pip install beautifulsoup4
    python3 tools/parse_agenda.py "Agenda - [un]prompted.html" data/agenda.json

How to get the input file: open the agenda page in Chrome, press Ctrl+S / Cmd+S and
save as "Webpage, HTML only" (or "Webpage, Complete"; only the .html file is read).

The script only reads the file you give it. It never touches the network.

What it does, in plain steps:
  1. Finds every <div class="stages"> block. Each block is one table for one
     stage on one day ("Stage 1 / Oct 27", "Villages / Oct 28", ...).
  2. Walks the table rows. A row with a time cell and a title cell is a session.
     A row that is only a long text cell (class "desc") is the abstract for the
     session above it. Empty "blank-row" rows are layout spacers and are skipped.
  3. Reads the "Evening events" list near the top of the page.
  4. Gives every session a stable id built from day + stage + start time, so
     bookmarks and notes survive when the organisers rename a talk or fill in a TBD.
  5. Writes everything as JSON and prints warnings for oddities in the source.
"""
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from urllib.parse import quote_plus

from bs4 import BeautifulSoup

SOURCE_URL = "https://unpromptedcon.org/agenda-10-2026/"
TIMEZONE = "America/Los_Angeles"

MONTHS = {m: i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July",
     "August", "September", "October", "November", "December"], start=1)}
MON_ABBR = {m[:3]: i for m, i in MONTHS.items()}

TIME_RE = re.compile(r"(\d{1,2}):(\d{2})\s*[–—-]\s*(\d{1,2}):(\d{2})")
# Titles that are logistics rather than content. They show as thin dividers in the app.
BREAK_RE = re.compile(
    r"^(coffee break|lunch break|move between rooms|gathering\s*&\s*mingling|"
    r"mingling\s*&\s*something sweet)$", re.I)

warnings = []


def clean(text):
    """Collapse runs of whitespace (including non-breaking spaces) to one space."""
    return re.sub(r"\s+", " ", (text or "").replace("\xa0", " ")).strip()


def hhmm(h, m):
    return f"{int(h):02d}:{int(m):02d}"


def minutes(t):
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def parse_stage_date(text):
    """'Oct 27, 2026 | Full Conference Days' -> '2026-10-27'."""
    m = re.search(r"([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})", text)
    if not m:
        raise ValueError(f"Cannot read a date from: {text!r}")
    return f"{int(m.group(3)):04d}-{MON_ABBR[m.group(1)]:02d}-{int(m.group(2)):02d}"


def paragraphs(cell):
    """Abstract cell -> list of paragraphs. The site separates them with <br>."""
    for br in cell.find_all("br"):
        br.replace_with("\n")
    parts = [clean(p) for p in cell.get_text().split("\n")]
    return [p for p in parts if p]


def speakers_from(cell):
    """Each <div class="speaker-part"> is '<span class=speaker>Name</span>, Role, Company'."""
    people = []
    for part in cell.select(".speaker-part"):
        for span in part.select("span.speaker"):
            name = clean(span.get_text())
            if not name:
                continue
            # Role text is whatever follows the name inside the same block.
            tail = ""
            for sib in span.next_siblings:
                if getattr(sib, "name", None) == "span" and "speaker" in (sib.get("class") or []):
                    break  # next speaker in the same block starts here
                tail += sib.get_text() if hasattr(sib, "get_text") else str(sib)
            role = clean(tail).lstrip(",;").strip()
            people.append({"name": name, "role": role})
    return people


def parse_stage_block(block):
    heading = block.find("h2")
    month = heading.find("span", class_="month")
    date = parse_stage_date(month.get_text())
    month.extract()
    name = clean(heading.get_text())          # "Stage 1", "Stage 2", "Villages"
    track = slug(name)
    note = ""
    items = []
    for tr in block.select("table tr"):
        cls = tr.get("class") or []
        if "blank-row" in cls:
            continue
        tds = tr.find_all("td", recursive=False)
        if not tds:
            continue
        # Long description row: attach to the previous session.
        if len(tds) == 1 and "desc" in (tds[0].get("class") or []):
            paras = paragraphs(tds[0])
            if paras and items:
                items[-1]["abstract"] = paras
            continue
        # One wide cell with text, no time: a note such as "Stage 2 opens at 9:25".
        if len(tds) == 1:
            txt = clean(tds[0].get_text())
            if txt:
                note = txt
            continue
        m = TIME_RE.search(tds[0].get_text())
        if not m:
            continue
        start, end = hhmm(m.group(1), m.group(2)), hhmm(m.group(3), m.group(4))
        title_el = tds[1].find("strong")
        title = clean(title_el.get_text() if title_el else tds[1].get_text())
        people = speakers_from(tds[1])
        if not title:
            title = "TBD"
        if title.upper().startswith("TBD"):
            kind = "tbd"
        elif BREAK_RE.match(title):
            kind = "break"
        elif track == "villages":
            kind = "village"
        else:
            kind = "talk"
        if minutes(end) <= minutes(start):
            warnings.append(f"{date} {name} {start}-{end} '{title}': end is not after start")
        items.append({"date": date, "track": track, "start": start, "end": end,
                      "title": title, "kind": kind, "speakers": people, "abstract": []})
    return {"date": date, "track": track, "name": name, "note": note, "items": items}


def parse_evening(soup):
    """The 'Evening events' bullet list near the top of the page."""
    events = []
    label = soup.find(string=re.compile(r"Evening events", re.I))
    if not label:
        warnings.append("No 'Evening events' list found")
        return events
    ul = label.find_parent().find_next("ul")
    for li in ul.find_all("li", recursive=False):
        link = li.find("a")
        address = clean(link.get_text()) if link else ""
        lines = [clean(x) for x in li.get_text("\n").split("\n")]
        lines = [x for x in lines if x and x != address]
        if len(lines) < 3:
            continue
        # lines[0] e.g. "Monday, October 26, 2026 | 6:00-10:00 PM", then title, then venue
        dm = re.search(r"([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*\|\s*(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})\s*(AM|PM)", lines[0], re.I)
        if not dm:
            warnings.append(f"Could not read evening event time: {lines[0]!r}")
            continue
        mon, day, year, h1, m1, h2, m2, ap = dm.groups()
        h1, h2 = int(h1), int(h2)
        if ap.upper() == "PM":
            h2 = h2 % 12 + 12
            h1 = h1 % 12 + (12 if h1 % 12 + 12 < h2 else 0)  # "6-10 PM" -> 18-22
        date = f"{int(year):04d}-{MONTHS[mon.capitalize()]:02d}-{int(day):02d}"
        start, end = hhmm(h1, m1), hhmm(h2, m2)
        maps = ("https://www.google.com/maps/search/?api=1&query=" +
                quote_plus(f"{lines[2]}, {address}")) if address else ""
        events.append({"date": date, "track": "evening", "start": start, "end": end,
                       "title": lines[1], "kind": "event", "venue": lines[2],
                       "address": address, "maps": maps, "speakers": [], "abstract": []})
    return events


def assign_ids(items):
    """id = date-track-start, e.g. 2026-10-27-stage-1-0935. Suffix if two share a slot."""
    seen = {}
    for it in items:
        base = f"{it['date']}-{it['track']}-{it['start'].replace(':', '')}"
        n = seen.get(base, 0)
        seen[base] = n + 1
        it["id"] = base if n == 0 else f"{base}-{chr(ord('a') + n)}"


def check_overlaps(blocks):
    for b in blocks:
        real = sorted(b["items"], key=lambda i: minutes(i["start"]))
        for a, c in zip(real, real[1:]):
            if minutes(c["start"]) < minutes(a["end"]):
                warnings.append(
                    f"{b['date']} {b['name']}: '{a['title']}' ({a['start']}-{a['end']}) "
                    f"overlaps '{c['title']}' ({c['start']}-{c['end']}) in the source")


def main(src, dst):
    html = open(src, encoding="utf-8", errors="replace").read()
    soup = BeautifulSoup(html, "html.parser")

    blocks = [parse_stage_block(b) for b in soup.select("div.stages")]
    if not blocks:
        sys.exit("No agenda tables found. Is this the saved agenda page?")
    evening = parse_evening(soup)

    all_items = [i for b in blocks for i in b["items"]] + evening
    assign_ids(all_items)
    check_overlaps(blocks)
    for it in all_items:
        if it["kind"] == "tbd":
            warnings.append(f"{it['date']} {it['start']} {it['track']}: title is still TBD")
        if it["kind"] == "talk" and not it["abstract"]:
            warnings.append(f"{it['date']} {it['start']} {it['track']}: '{it['title']}' has no abstract yet")

    tracks = []
    for b in blocks:
        if not any(t["id"] == b["track"] for t in tracks):
            tracks.append({"id": b["track"], "name": b["name"]})
    tracks.append({"id": "evening", "name": "Evening"})
    notes = {f"{b['date']}|{b['track']}": b["note"] for b in blocks if b["note"]}

    out = {
        "conference": {"name": "[un]prompted II", "tagline": "The AI Security Practitioner Conference",
                       "city": "San Francisco", "timezone": TIMEZONE, "source": SOURCE_URL},
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tracks": tracks,
        "trackNotes": notes,
        "items": sorted(all_items, key=lambda i: (i["date"], i["start"], i["track"])),
    }
    body = json.dumps(out, ensure_ascii=False, indent=1)
    out["version"] = hashlib.sha1(body.encode()).hexdigest()[:10]
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    by_kind = {}
    for i in all_items:
        by_kind[i["kind"]] = by_kind.get(i["kind"], 0) + 1
    print(f"Wrote {dst}: {len(all_items)} items {by_kind}, version {out['version']}")
    for w in warnings:
        print("  warning:", w)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
