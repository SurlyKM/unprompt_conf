# [un]prompted II companion

Personal agenda app for [un]prompted II (San Francisco, 27 to 29 Oct 2026). Static files only, no backend, works offline.

## Put it on GitHub Pages

1. Push everything in this folder to the root of a repo.
2. Repo Settings, Pages, "Deploy from a branch", branch `main`, folder `/ (root)`.
3. Open the Pages URL once on good wifi. That first visit stores the whole app on the phone, so it works offline after that.

## Update the schedule

Several slots are still TBD and a few sessions have no abstract yet. When the organisers update the page:

1. Open https://unpromptedcon.org/agenda-10-2026/ in Chrome, press Ctrl+S (Cmd+S), save as "Webpage, HTML only".
2. Run:

   ```
   pip install beautifulsoup4
   python3 tools/parse_agenda.py "Agenda - [un]prompted.html" data/agenda.json
   ```

3. Commit and push `data/agenda.json`. Phones pick it up on their next visit after the one that downloads it.

The script prints warnings for anything odd in the source (missing abstracts, TBD titles, impossible times). It only reads the file you give it.

Bookmarks and notes are keyed by day + stage + start time, so they survive renamed talks and filled-in TBDs. They would only detach if the organisers move a session to a different start time.

## Things to know

- All times are San Francisco time. "Now" and "Up next" use SF time wherever the phone is.
- Preview a moment in the conference by adding `?now=2026-10-27T10:05` to the URL.
- Clash detection looks at bookmarked sessions only. Breaks and villages (CTF, Harness, Defense) never count as clashes.
- Everything you save stays in the browser's localStorage on that device. Clearing site data clears it.
- Known source quirks, shown as published: Thu 29 Stage 2 "Mingling" has an end time before its start (shown with start only), Wed 28 Stage 1 "Closing remarks" overlaps "Mingling", and Wed 28 Stage 2 has a talk starting 13:35 that overlaps the one before it.

## Files

| File | What it does |
|---|---|
| `index.html` | Page shell |
| `app.css` | Styles, dark by default, light follows the phone |
| `app.js` | All app logic, commented in six sections |
| `sw.js` | Offline cache (change `CACHE` to force phones to drop old files) |
| `data/agenda.json` | The schedule |
| `tools/parse_agenda.py` | Saved agenda page to `agenda.json` |
| `fonts/` | Inter and IBM Plex Mono, self-hosted so offline works |
