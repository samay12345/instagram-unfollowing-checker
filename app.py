import logging
import os
import threading
import time
import uuid
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__)
logger = logging.getLogger(__name__)
if not logging.root.handlers:
    logging.basicConfig(level=logging.INFO)

_BAD_PASSWORD_HINT = (
    "Instagram often reports this when it distrusts the login (wrong password *or* IP/device reputation). "
)

_LOGIN_DEBUG_ENV = "IGUC_LOGIN_DEBUG"

# In-memory only — never persisted to disk
sessions = {}  # {sid: {client, username, user_id, ts}}
tasks = {}  # {tid: {status, msg, data, error, ts}}
pending_logins = {}  # {pid: {settings, last_json, username, ts}} — mid–2FA resume
_lock = threading.Lock()

ROOT = Path(__file__).resolve().parent
FRONTEND_DIST = ROOT / "frontend" / "dist"


def _spa_ready():
    return FRONTEND_DIST.is_dir() and (FRONTEND_DIST / "index.html").is_file()


def _cleanup_loop():
    while True:
        time.sleep(300)
        now = time.time()
        with _lock:
            for k in [k for k, v in list(sessions.items()) if now - v["ts"] > 3600]:
                del sessions[k]
            for k in [k for k, v in list(tasks.items()) if now - v["ts"] > 1800]:
                del tasks[k]
            for k in [k for k, v in list(pending_logins.items()) if now - v["ts"] > 900]:
                del pending_logins[k]


threading.Thread(target=_cleanup_loop, daemon=True).start()


def _login_debug_enabled() -> bool:
    return os.environ.get(_LOGIN_DEBUG_ENV, "").strip().lower() in ("1", "true", "yes")


def _log_login_failure(context: str, exc: BaseException) -> None:
    if not _login_debug_enabled():
        return
    msg = _exc_detail(exc)
    if len(msg) > 800:
        msg = msg[:800] + "…"
    logger.info(
        "login_failure context=%s exc_type=%s message=%s",
        context,
        type(exc).__name__,
        msg,
    )


def _bad_password_message(exc: BaseException) -> str:
    detail = _exc_detail(exc)
    hint_low = _BAD_PASSWORD_HINT.lower().strip()
    if detail.lower().startswith(hint_low):
        return detail
    return _BAD_PASSWORD_HINT + detail


def _normalize_sessionid_cookie(raw: str) -> str:
    v = (raw or "").strip().strip('"').strip("'")
    low = v.lower()
    if low.startswith("sessionid="):
        v = v.split("=", 1)[1].strip()
    if ";" in v:
        v = v.split(";", 1)[0].strip()
    return v


def _client():
    from instagrapi import Client

    cl = Client()
    # Conservative jitter — reduces hammering; tune with IGUC_* env vars below.
    cl.delay_range = [1.0, 2.5]

    locale = os.environ.get("IGUC_LOCALE", "").strip()
    country = os.environ.get("IGUC_COUNTRY", "").strip()
    if locale:
        cl.set_locale(locale)
    elif country:
        cl.set_country(country)

    return cl


def _exc_detail(exc: BaseException) -> str:
    msg = getattr(exc, "message", None) or getattr(exc, "msg", None)
    if msg is not None and str(msg).strip():
        return str(msg).strip()
    return str(exc).strip()


def _touch_session(sid: str) -> None:
    if sid in sessions:
        sessions[sid]["ts"] = time.time()


def _finalize_ig_session(cl):
    sid = str(uuid.uuid4())
    with _lock:
        sessions[sid] = {
            "client": cl,
            "username": cl.username,
            "user_id": cl.user_id,
            "ts": time.time(),
        }
    return jsonify({"ok": True, "session_id": sid, "username": cl.username})


@app.route("/")
def spa_index():
    if not _spa_ready():
        return (
            "<!DOCTYPE html><html><body style='font-family:sans-serif;padding:2rem'>"
            "<h1>Frontend not built</h1>"
            "<p>From <code>frontend/</code> run <code>npm install</code> then "
            "<code>npm run build</code>, or use <code>npm run dev</code> for development "
            "(see README).</p></body></html>",
            503,
            {"Content-Type": "text/html; charset=utf-8"},
        )
    return send_from_directory(FRONTEND_DIST, "index.html")


@app.route("/assets/<path:name>")
def vite_assets(name):
    if not _spa_ready():
        return jsonify({"error": "Frontend not built."}), 503
    d = FRONTEND_DIST / "assets"
    if not (d / name).is_file():
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(d, name)


@app.route("/favicon.svg")
def favicon():
    if not _spa_ready():
        return ("", 404)
    p = FRONTEND_DIST / "favicon.svg"
    return send_from_directory(FRONTEND_DIST, "favicon.svg") if p.is_file() else ("", 404)


@app.route("/icons.svg")
def icons_svg():
    if not _spa_ready():
        return ("", 404)
    p = FRONTEND_DIST / "icons.svg"
    return send_from_directory(FRONTEND_DIST, "icons.svg") if p.is_file() else ("", 404)


@app.route("/api/login", methods=["POST"])
def api_login():
    from instagrapi.exceptions import (
        BadCredentials,
        BadPassword,
        ChallengeRequired,
        ClientConnectionError,
        ClientForbiddenError,
        FeedbackRequired,
        LoginRequired,
        PleaseWaitFewMinutes,
        RateLimitError,
        ReloginAttemptExceeded,
        SentryBlock,
        TwoFactorRequired,
    )

    body = request.get_json(silent=True) or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    verification_code = (body.get("verification_code") or "").strip()
    pending_id = body.get("pending_id")

    if pending_id:
        if not username or not password:
            return jsonify(
                {"ok": False, "error": "Username and password are required to complete two-factor login."}
            )
        if not verification_code:
            return jsonify({"ok": False, "error": "Enter the verification code from your authenticator app."})
        with _lock:
            pend = pending_logins.pop(pending_id, None)
        if not pend:
            return jsonify(
                {
                    "ok": False,
                    "error": "Two-factor session expired (waited too long). Please log in again from the start.",
                }
            )
        if pend["username"] != username:
            return jsonify({"ok": False, "error": "Username does not match the pending login. Try again."})
        cl = _client()
        cl.set_settings(pend["settings"])
        lj = pend.get("last_json") or {}
        if lj:
            cl.last_json = lj
        try:
            cl.login(username, password, verification_code=verification_code)
        except TwoFactorRequired as exc:
            _log_login_failure("login_2fa_step", exc)
            new_pid = str(uuid.uuid4())
            with _lock:
                pending_logins[new_pid] = {
                    "settings": cl.get_settings(),
                    "last_json": dict(cl.last_json) if isinstance(getattr(cl, "last_json", None), dict) else {},
                    "username": username,
                    "ts": time.time(),
                }
            return jsonify(
                {
                    "ok": False,
                    "needs_two_factor": True,
                    "pending_id": new_pid,
                    "error": _exc_detail(exc),
                }
            )
        except BadPassword as exc:
            _log_login_failure("login_2fa_bad_password", exc)
            return jsonify({"ok": False, "error": _bad_password_message(exc)})
        except Exception as exc:
            _log_login_failure("login_2fa_other", exc)
            logger.warning("Login failed after 2FA: %s — %s", type(exc).__name__, _exc_detail(exc))
            return jsonify({"ok": False, "error": _exc_detail(exc)})
    else:
        if not username or not password:
            return jsonify({"ok": False, "error": "Username and password are required."})

        cl = _client()
        try:
            cl.login(username, password, verification_code=verification_code)
        except BadCredentials as exc:
            _log_login_failure("login_bad_credentials", exc)
            return jsonify({"ok": False, "error": _exc_detail(exc)})
        except BadPassword as exc:
            _log_login_failure("login_bad_password", exc)
            return jsonify({"ok": False, "error": _bad_password_message(exc)})
        except TwoFactorRequired as exc:
            _log_login_failure("login_two_factor_required", exc)
            if verification_code:
                return jsonify({"ok": False, "error": _exc_detail(exc)})
            new_pid = str(uuid.uuid4())
            with _lock:
                pending_logins[new_pid] = {
                    "settings": cl.get_settings(),
                    "last_json": dict(cl.last_json) if isinstance(getattr(cl, "last_json", None), dict) else {},
                    "username": username,
                    "ts": time.time(),
                }
            return jsonify(
                {
                    "ok": False,
                    "needs_two_factor": True,
                    "pending_id": new_pid,
                    "error": "Two-factor authentication is required. Enter the code from your authenticator app.",
                }
            )
        except ChallengeRequired as exc:
            _log_login_failure("login_challenge", exc)
            return jsonify(
                {
                    "ok": False,
                    "error": (
                        "Instagram requires a security check (challenge). Open the Instagram app, "
                        "complete verification, wait a few minutes, then try again here."
                    ),
                }
            )
        except FeedbackRequired as exc:
            return jsonify({"ok": False, "error": _exc_detail(exc)})
        except PleaseWaitFewMinutes as exc:
            return jsonify(
                {
                    "ok": False,
                    "error": (
                        f"{_exc_detail(exc)} Try again in a few minutes; Instagram often rate-limits "
                        "automated login attempts."
                    ),
                }
            )
        except RateLimitError as exc:
            return jsonify({"ok": False, "error": _exc_detail(exc)})
        except SentryBlock as exc:
            return jsonify(
                {
                    "ok": False,
                    "error": (
                        f"{_exc_detail(exc)} This usually means Instagram temporarily blocked this login style. "
                        "Try again later or from another network."
                    ),
                }
            )
        except ReloginAttemptExceeded as exc:
            return jsonify({"ok": False, "error": _exc_detail(exc)})
        except ClientForbiddenError as exc:
            return jsonify(
                {
                    "ok": False,
                    "error": (
                        f"{_exc_detail(exc)} If your password is correct, your IP or device may be restricted — "
                        "try again later or another network."
                    ),
                }
            )
        except ClientConnectionError as exc:
            return jsonify({"ok": False, "error": f"Network error: {_exc_detail(exc)}"})
        except LoginRequired as exc:
            return jsonify({"ok": False, "error": _exc_detail(exc)})
        except Exception as exc:
            msg = _exc_detail(exc)
            _log_login_failure("login_password_unexpected", exc)
            low = msg.lower()
            logger.warning("Login unexpected %s: %s", type(exc).__name__, msg)
            if "challenge" in low or "verify" in low:
                return jsonify(
                    {
                        "ok": False,
                        "error": "Instagram requires verification. Use the mobile app to confirm your account, then retry.",
                    }
                )
            return jsonify({"ok": False, "error": msg})

    return _finalize_ig_session(cl)


@app.route("/api/login/session", methods=["POST"])
def api_login_session():
    """Log in using the Instagram browser cookie ``sessionid`` (memory-only; never persisted)."""
    from pydantic import ValidationError

    from instagrapi.exceptions import (
        ChallengeRequired,
        ClientConnectionError,
        ClientForbiddenError,
        FeedbackRequired,
        LoginRequired,
        PleaseWaitFewMinutes,
        RateLimitError,
        ReloginAttemptExceeded,
        SentryBlock,
    )

    body = request.get_json(silent=True) or {}
    cookie = _normalize_sessionid_cookie(body.get("sessionid") or body.get("session_id_cookie") or "")
    if not cookie:
        return jsonify(
            {
                "ok": False,
                "error": (
                    "Paste only your own Instagram sessionid cookie from a browser where you are already logged in "
                    "(see README). Nothing is saved to disk."
                ),
            }
        )
    if len(cookie) <= 30:
        return jsonify(
            {
                "ok": False,
                "error": "That value looks too short to be a full sessionid. Copy the entire cookie value.",
            }
        )
    if not cookie[0].isdigit():
        return jsonify(
            {
                "ok": False,
                "error": "sessionid normally starts with digits. Recheck you copied the sessionid cookie, not another field.",
            }
        )

    cl = _client()
    try:
        cl.login_by_sessionid(cookie)
    except ValidationError as exc:
        _log_login_failure("login_session_validation", exc)
        return jsonify({"ok": False, "error": _exc_detail(exc)})
    except ChallengeRequired as exc:
        _log_login_failure("login_session_challenge", exc)
        return jsonify(
            {
                "ok": False,
                "error": (
                    "Instagram wants a security check on this session. Open instagram.com in your browser, "
                    "complete any prompts, then copy a fresh sessionid."
                ),
            }
        )
    except FeedbackRequired as exc:
        _log_login_failure("login_session_feedback", exc)
        return jsonify({"ok": False, "error": _exc_detail(exc)})
    except PleaseWaitFewMinutes as exc:
        _log_login_failure("login_session_wait", exc)
        return jsonify(
            {
                "ok": False,
                "error": (
                    f"{_exc_detail(exc)} Wait several minutes before retrying; Instagram rate-limits unusual requests."
                ),
            }
        )
    except RateLimitError as exc:
        _log_login_failure("login_session_ratelimit", exc)
        return jsonify({"ok": False, "error": _exc_detail(exc)})
    except SentryBlock as exc:
        _log_login_failure("login_session_sentry", exc)
        return jsonify(
            {
                "ok": False,
                "error": (
                    f"{_exc_detail(exc)} Try again later or from another network; Instagram blocked this request pattern."
                ),
            }
        )
    except ReloginAttemptExceeded as exc:
        _log_login_failure("login_session_relogin", exc)
        return jsonify({"ok": False, "error": _exc_detail(exc)})
    except ClientForbiddenError as exc:
        _log_login_failure("login_session_forbidden", exc)
        return jsonify(
            {
                "ok": False,
                "error": (
                    f"{_exc_detail(exc)} The cookie may be expired or revoked — log in again in the browser and paste a new sessionid."
                ),
            }
        )
    except ClientConnectionError as exc:
        _log_login_failure("login_session_network", exc)
        return jsonify({"ok": False, "error": f"Network error: {_exc_detail(exc)}"})
    except LoginRequired as exc:
        _log_login_failure("login_session_login_required", exc)
        return jsonify(
            {
                "ok": False,
                "error": (
                    f"{_exc_detail(exc)} Session cookie invalid or expired. Log in on instagram.com again and copy sessionid."
                ),
            }
        )
    except Exception as exc:
        _log_login_failure("login_session_other", exc)
        msg = _exc_detail(exc)
        low = msg.lower()
        if "challenge" in low or "verify" in low:
            return jsonify(
                {
                    "ok": False,
                    "error": "Instagram requires verification. Confirm your account in the browser, then try a fresh sessionid.",
                }
            )
        if "invalid sessionid" in low or "assert" in low:
            return jsonify(
                {
                    "ok": False,
                    "error": "Could not use that sessionid. Ensure you copied the full cookie value from an active login.",
                }
            )
        return jsonify({"ok": False, "error": msg})

    return _finalize_ig_session(cl)


def _normalize_import_row(entry):
    if not isinstance(entry, dict):
        return None
    username = (entry.get("username") or "").strip().lstrip("@")
    if not username:
        return None
    uid = entry.get("id") if entry.get("id") is not None else entry.get("pk")
    user_id = str(uid).strip() if uid is not None and str(uid).strip() else ""
    fn = entry.get("full_name") if entry.get("full_name") is not None else entry.get("fullName")
    full_name = str(fn).strip() if fn is not None and str(fn).strip() else ""
    pic_raw = entry.get("pic") if entry.get("pic") is not None else entry.get("profile_pic_url")
    pic = str(pic_raw).strip() if pic_raw is not None and str(pic_raw).strip() else ""
    return {
        "user_id": user_id,
        "username": username,
        "full_name": full_name,
        "pic": pic,
    }


@app.route("/api/import-lists", methods=["POST"])
def api_import_lists():
    """Compare follower/following arrays from the Playwright collector (no instagrapi session)."""
    body = request.get_json(silent=True) or {}
    raw_followers = body.get("followers")
    raw_following = body.get("following")
    if not isinstance(raw_followers, list) or not isinstance(raw_following, list):
        return jsonify({"ok": False, "error": "Expected JSON with followers[] and following[] arrays."}), 400

    followers_rows = []
    seen_f = set()
    for item in raw_followers:
        row = _normalize_import_row(item)
        if row:
            key = row["username"].lower()
            if key not in seen_f:
                seen_f.add(key)
                followers_rows.append(row)

    following_rows = []
    seen_g = set()
    for item in raw_following:
        row = _normalize_import_row(item)
        if row:
            key = row["username"].lower()
            if key not in seen_g:
                seen_g.add(key)
                following_rows.append(row)

    follower_names = {r["username"].lower() for r in followers_rows}
    non_followers = sorted(
        [u for u in following_rows if u["username"].lower() not in follower_names],
        key=lambda x: x["username"].lower(),
    )

    data = {
        "non_followers": non_followers,
        "followers_count": len(followers_rows),
        "following_count": len(following_rows),
    }
    return jsonify({"ok": True, "data": data})


@app.route("/api/fetch", methods=["POST"])
def api_fetch():
    body = request.get_json(silent=True) or {}
    sid = body.get("session_id")

    with _lock:
        session = sessions.get(sid)

    if not session:
        return jsonify({"ok": False, "error": "Session not found. Please log in again."})

    _touch_session(sid)

    tid = str(uuid.uuid4())
    with _lock:
        tasks[tid] = {"status": "running", "msg": "Fetching lists…", "data": None, "error": None, "ts": time.time()}

    def worker():
        from instagrapi.exceptions import LoginRequired

        with _lock:
            sess = sessions.get(sid)
        if not sess:
            with _lock:
                tasks[tid].update({"status": "error", "error": "Session expired."})
            return

        cl = sess["client"]
        uid = sess["user_id"]

        try:
            with _lock:
                tasks[tid]["msg"] = "Loading followers…"
            followers = cl.user_followers(uid, amount=0)

            with _lock:
                tasks[tid]["msg"] = f"{len(followers):,} followers — loading following…"
            following = cl.user_following(uid, amount=0)

            with _lock:
                tasks[tid]["msg"] = "Comparing lists…"

            not_back = sorted(
                [
                    {
                        "user_id": str(pk),
                        "username": u.username,
                        "full_name": u.full_name or "",
                        "pic": str(u.profile_pic_url) if u.profile_pic_url else "",
                    }
                    for pk, u in following.items()
                    if pk not in followers
                ],
                key=lambda x: x["username"].lower(),
            )

            with _lock:
                sessions[sid]["ts"] = time.time()
                tasks[tid].update({
                    "status": "done",
                    "data": {
                        "non_followers": not_back,
                        "followers_count": len(followers),
                        "following_count": len(following),
                    },
                })

        except LoginRequired:
            with _lock:
                tasks[tid].update({"status": "error", "error": "Instagram logged you out. Please log in again."})
        except Exception as exc:
            with _lock:
                tasks[tid].update({"status": "error", "error": _exc_detail(exc)})

    threading.Thread(target=worker, daemon=True).start()
    return jsonify({"ok": True, "task_id": tid})


@app.route("/api/task/<tid>")
def api_task(tid):
    with _lock:
        t = tasks.get(tid)
    if not t:
        return jsonify({"status": "not_found"})
    return jsonify({"status": t["status"], "msg": t["msg"], "data": t["data"], "error": t["error"]})


@app.route("/api/logout", methods=["POST"])
def api_logout():
    body = request.get_json(silent=True) or {}
    sid = body.get("session_id")
    with _lock:
        sessions.pop(sid, None)
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(debug=False, host="127.0.0.1", port=5000)
