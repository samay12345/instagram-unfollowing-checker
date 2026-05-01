import uuid
import time
import random
import threading
from flask import Flask, request, jsonify, render_template

app = Flask(__name__)

# In-memory stores — nothing is persisted to disk
sessions = {}   # {sid: {client, username, user_id, ts}}
tasks = {}      # {tid: {status, msg, data, error, ts}}
_lock = threading.Lock()


def _cleanup_loop():
    while True:
        time.sleep(300)
        now = time.time()
        with _lock:
            for k in [k for k, v in list(sessions.items()) if now - v["ts"] > 3600]:
                del sessions[k]
            for k in [k for k, v in list(tasks.items()) if now - v["ts"] > 1800]:
                del tasks[k]


threading.Thread(target=_cleanup_loop, daemon=True).start()


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/login", methods=["POST"])
def api_login():
    from instagrapi import Client
    from instagrapi.exceptions import BadPassword, ChallengeRequired, TwoFactorRequired

    body = request.get_json(silent=True) or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""

    if not username or not password:
        return jsonify({"ok": False, "error": "Username and password are required."})

    cl = Client()
    cl.delay_range = [2, 5]

    try:
        cl.login(username, password)
    except BadPassword:
        return jsonify({"ok": False, "error": "Incorrect username or password."})
    except ChallengeRequired:
        return jsonify({
            "ok": False,
            "error": (
                "Instagram flagged this login and requires a security challenge. "
                "Open the Instagram app, complete any verification prompts, "
                "then try logging in here again."
            ),
        })
    except TwoFactorRequired:
        return jsonify({
            "ok": False,
            "error": (
                "Two-factor authentication is enabled on this account. "
                "Please temporarily disable 2FA in the Instagram app, "
                "log in here, then re-enable it."
            ),
        })
    except Exception as exc:
        msg = str(exc)
        if "challenge" in msg.lower() or "verify" in msg.lower():
            return jsonify({
                "ok": False,
                "error": "Instagram requires account verification. Please open the Instagram app and complete any security checks.",
            })
        return jsonify({"ok": False, "error": f"Login failed: {msg}"})

    sid = str(uuid.uuid4())
    with _lock:
        sessions[sid] = {
            "client": cl,
            "username": cl.username,
            "user_id": cl.user_id,
            "ts": time.time(),
        }

    return jsonify({"ok": True, "session_id": sid, "username": cl.username})


@app.route("/api/fetch", methods=["POST"])
def api_fetch():
    body = request.get_json(silent=True) or {}
    sid = body.get("session_id")

    with _lock:
        session = sessions.get(sid)

    if not session:
        return jsonify({"ok": False, "error": "Session not found. Please log in again."})

    tid = str(uuid.uuid4())
    with _lock:
        tasks[tid] = {"status": "running", "msg": "Starting…", "data": None, "error": None, "ts": time.time()}

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
                tasks[tid]["msg"] = "Fetching your followers… (may take a minute for large accounts)"
            followers = cl.user_followers(uid, amount=0)

            with _lock:
                tasks[tid]["msg"] = f"Got {len(followers):,} followers. Fetching accounts you follow…"
            time.sleep(random.uniform(2, 4))
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
                tasks[tid].update({
                    "status": "done",
                    "data": {
                        "non_followers": not_back,
                        "followers": len(followers),
                        "following": len(following),
                    },
                })

        except LoginRequired:
            with _lock:
                tasks[tid].update({"status": "error", "error": "Instagram logged you out. Please log in again."})
        except Exception as exc:
            with _lock:
                tasks[tid].update({"status": "error", "error": str(exc)})

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
