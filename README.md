# Instagram Unfollow Checker

Small **local-only** tool: connect to Instagram (or load lists from your browser), fetch **followers** and **following**, then list accounts you follow who **don’t follow you back**. The Flask backend keeps sessions **in RAM only** (nothing is written to disk unless you change the code yourself).

## Browser collector path (recommended when API login fails)

A **Playwright** script in `collector/` opens real Chromium: you log in manually, then it scrolls your **Followers** / **Following** dialogs and merges **GraphQL JSON** (`instagram.com/graphql/query`) with **DOM** link scraping. It writes `collector/out/followers.json`, `following.json`, and `non_followers.json`.

```bash
cd collector && npm install && npm run collect
```

Then in the web UI choose **Browser JSON**, upload those files, and click **Compare & show results**. Flask endpoint: `POST /api/import-lists` (no instagrapi). Optional: `IGUC_API_BASE=http://127.0.0.1:5000 npm run collect -- --upload` to POST lists directly (you still open the UI if you want charts).

Details and troubleshooting: **`collector/README.md`**. Instagram UI/API changes can break selectors or JSON shapes — this path is usually easier on **login**, not immortal.

## Password vs session vs browser import

| Method | What you enter | When to use |
|--------|----------------|-------------|
| **Password** | Instagram username + password (+ 2FA code if prompted) | Default; same limits as any unofficial client (IP/trust, challenges). |
| **Session** | Browser **`sessionid`** cookie | Trust/IP issues but browser session works; still uses instagrapi after cookie exchange. |
| **Browser JSON** | `followers.json` + `following.json` from **`npm run collect`** | No Instagram credentials in the web app — only compares uploaded arrays. |

### Session cookie (`sessionid`)

- **Only use cookies from your own account** in your own browser. A `sessionid` is effectively full access to that account; treat it like a password.
- Copy **only** the cookie **value** (the UI accepts optional `sessionid=` prefix and strips it).
- Cookies **expire** or are **invalidated** when Instagram logs you out or you change your password — paste a **fresh** value if login fails.
- This flow still uses **instagrapi** against unofficial endpoints; it may violate Instagram’s terms and can still be blocked.

### Password login notes

- **`bad_password` responses** from Instagram often mean **distrusted login / IP / device**, not necessarily a typo. The app prefixes those messages to say so when possible.
- **2FA**: First response may return `needs_two_factor` + `pending_id`. Submit the **same username/password** plus the **authenticator code** to finish (no need to disable 2FA).

### Optional environment variables (backend)

| Variable | Purpose |
|----------|---------|
| `IGUC_LOGIN_DEBUG=1` | Log structured login failures (`exc_type` + truncated message) to help debugging. **Never** logs your password or raw cookie. |
| `IGUC_LOCALE` | e.g. `en_US` — passed to instagrapi `set_locale` if set. |
| `IGUC_COUNTRY` | e.g. `US` — passed to `set_country` if **`IGUC_LOCALE` is unset**. |

Client requests use conservative **`delay_range`** (about **1–3 seconds** jitter) to reduce hammering; this cannot bypass Instagram’s anti-abuse decisions.

## What still cannot be fixed in this repo

- Instagram may block unofficial clients, challenges, rate limits, or account-specific restrictions — **no code change guarantees** access.
- We do **not** add proxies, CAPTCHA solvers, or other **evasion** mechanisms.

## Run (development)

Uses **Vite + React + TypeScript** in `frontend/` with a **proxy** to Flask so the browser only talks to port **5173**.

**Terminal 1 — backend**

```bash
cd /path/to/instagram-unfollowing-checker
python3 -m venv .venv && source .venv/bin/activate   # optional
pip install -r requirements.txt
python app.py
```

**Terminal 2 — frontend**

```bash
cd frontend
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. API calls go to **http://127.0.0.1:5000** via the dev proxy.

## Run (production-style, single server)

Build the UI, then serve everything from Flask:

```bash
pip install -r requirements.txt
cd frontend && npm install && npm run build && cd ..
python app.py
```

Open **http://127.0.0.1:5000**.

If you skip `npm run build`, `/` shows instructions instead of the SPA.

## Notes

- Bound to **127.0.0.1** by default — do not expose this app to untrusted networks.
