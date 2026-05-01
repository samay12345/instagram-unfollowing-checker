# Browser collector (Playwright)

Collects **followers** and **following** using a real Chromium window so you sign in like normal. Data comes from:

1. **Network:** responses whose URLs match `instagram.com/graphql/query` or `instagram.com/api/v1/friendships/` — JSON is walked for `{ username, pk/id }` shapes (`extract.ts`).
2. **DOM fallback:** visible profile links inside the modal (`a[href="/handle/"]`) while scrolling.

Output files (default `./out/`):

| File | Contents |
|------|-----------|
| `followers.json` | `[{ username, id?, full_name? }]` |
| `following.json` | same |
| `non_followers.json` | following − followers |
| `meta.json` | `profile_username`, `exported_at` |

## Setup

```bash
cd collector
npm install
```

(`postinstall` downloads Chromium via Playwright.)

## Run

**Terminal 1 — Flask + UI (optional for `--upload`)**

```bash
cd .. && python app.py
```

**Terminal 2 — Collector**

```bash
cd collector
npm run collect
```

Flow:

1. Chromium opens → log in on instagram.com (complete any checkpoint).
2. Return to the terminal, press **Enter** when your feed loads.
3. Enter your **username handle** (no `@`).
4. The script opens Followers / Following modals and scrolls until counts stabilize.

Optional: push lists straight into the running API:

```bash
IGUC_API_BASE=http://127.0.0.1:5000 npm run collect -- --upload
```

Then open the web app → **Browser import** tab → you can also load the same JSON files manually.

## Troubleshooting

- **Selectors failed:** Instagram changed UI — update link selectors in `collect.ts` or rely more on DOM scraping by increasing scroll rounds.
- **Tiny lists:** Scroll container not found — complete challenge in browser; try again when dialogs load fully.
- **Large accounts:** Collection stops after ~12 scroll rounds with no growth; increase thresholds in `collect.ts` if needed.

Nothing stores your password. Session lives in the Playwright browser profile for that run only (memory unless you opt into persistent contexts — not enabled here).
