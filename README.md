# [un]prompted II companion (version 2)

Personal agenda app for [un]prompted II (San Francisco, 27 to 29 Oct 2026). Layout and look follow the BSides Canberra schedule app. Static files only, no backend, works offline.

## Put it on GitHub Pages

1. Push everything in this folder to the root of a repo.
2. Repo Settings, Pages, "Deploy from a branch", branch `main`, folder `/ (root)`.
3. Open the Pages URL once on good wifi. That first visit stores the whole app on the phone, so it works offline after that.

If you deploy to the same address as version 1, your existing stars, notes and ratings carry over.

## What is in it

- **Now**: big San Francisco clock, what is on now with progress bars, what is up next, and a banner if your starred talks clash.
- **Schedule**: one day at a time (swipe left or right to change day). Villages tuck into a strip at the top. Stage chips and the Everyone / Mine switch filter the list.
- **My plan**: everything you starred across all days, with clashes outlined, plus talks you flagged "want to talk to".
- **Details sheet**: tap any talk for the abstract and speakers (role as published, their other sessions, a web search link), your notes, a 1 to 5 rating and a one-line takeaway. The browser back button closes the sheet.
- **Search**: titles, speakers, abstracts and your own notes, across all days.

## Update the schedule

Several slots are still TBD and a few sessions have no abstract yet. When the organisers update the page:

1. Open https://unpromptedcon.org/agenda-10-2026/ in Chrome, press Ctrl+S (Cmd+S), save as "Webpage, HTML only".
2. Run:

   ```
   pip install beautifulsoup4
   python3 tools/parse_agenda.py "Agenda - [un]prompted.html" data/agenda.json
   ```

3. Commit and push `data/agenda.json`. Phones pick it up on their next visit after the one that downloads it.

The script prints warnings for anything odd in the source. It only reads the file you give it.

Stars and notes are keyed by day + stage + start time, so they survive renamed talks and filled-in TBDs. They would only detach if the organisers move a session to a different start time.

## Things to know

- All times are San Francisco time. Preview a moment by adding `?now=2026-10-27T10:05` to the URL.
- Clash detection looks at starred sessions only. Breaks and villages (CTF, Harness, Defense) never count as clashes.
- Everything you save stays in the browser's localStorage on that device. Clearing site data in Chrome clears it.
- Known source quirks, shown as published: Thu 29 Stage 2 "Mingling" has an end time before its start (shown with start only).
- Dark theme only, like the BSides app.

## Files

| File | What it does |
|---|---|
| `index.html` | Page shell |
| `app.css` | Styles |
| `app.js` | All app logic, commented in seven sections |
| `sw.js` | Offline cache (change `CACHE` to force phones to drop old files) |
| `data/agenda.json` | The schedule |
| `tools/parse_agenda.py` | Saved agenda page to `agenda.json` |
| `fonts/` | Bricolage Grotesque and Atkinson Hyperlegible, self-hosted so offline works |
