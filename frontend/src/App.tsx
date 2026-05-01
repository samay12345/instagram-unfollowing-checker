import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  getJson,
  postJson,
  type FetchResultPayload,
  type LoginResponse,
  type NonFollower,
  type TaskResponse,
} from './api'

type Phase = 'login' | 'loading' | 'results'

const SESSION_KEY = 'iguc_sid'
const USER_KEY = 'iguc_user'
const POLL_MS = 720

function avatarHue(username: string): string {
  const palette = [
    '#2563eb',
    '#0891b2',
    '#4f46e5',
    '#0d9488',
    '#7c3aed',
    '#0369a1',
    '#4338ca',
  ]
  let h = 0
  for (const c of username || 'x') h = (h * 31 + c.charCodeAt(0)) | 0
  return palette[Math.abs(h) % palette.length]
}

type LoginMethod = 'password' | 'session'

export default function App() {
  const [phase, setPhase] = useState<Phase>('login')
  const [loginMethod, setLoginMethod] = useState<LoginMethod>('password')
  const [sessionCookie, setSessionCookie] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [loggedUser, setLoggedUser] = useState<string | null>(() =>
    sessionStorage.getItem(USER_KEY),
  )
  const [loginError, setLoginError] = useState('')
  const [loadingMsg, setLoadingMsg] = useState('Connecting…')
  const [loginBusy, setLoginBusy] = useState(false)
  const [results, setResults] = useState<FetchResultPayload | null>(null)
  const [filter, setFilter] = useState('')
  const pollIntervalRef = useRef<number | null>(null)

  const stopPoll = useCallback(() => {
    if (pollIntervalRef.current != null) {
      window.clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }, [])

  useEffect(() => () => stopPoll(), [stopPoll])

  const startFetch = useCallback(async () => {
    const sid = sessionStorage.getItem(SESSION_KEY)
    if (!sid) {
      setPhase('login')
      setLoginError('Session expired. Please log in again.')
      return
    }
    setLoadingMsg('Starting…')
    setPhase('loading')
    stopPoll()
    try {
      const res = await postJson<{ ok?: boolean; task_id?: string; error?: string }>(
        '/api/fetch',
        { session_id: sid },
      )
      if (!res.ok || !res.task_id) {
        setPhase('login')
        setLoginError(res.error ?? 'Could not start sync.')
        return
      }
      const poll = async () => {
        try {
          const t = await getJson<TaskResponse>(`/api/task/${res.task_id}`)
          if (t.status === 'not_found') {
            stopPoll()
            setPhase('login')
            setLoginError('Task expired. Try again.')
            return
          }
          if (t.status === 'running') {
            setLoadingMsg(t.msg ?? 'Working…')
            return
          }
          if (t.status === 'error') {
            stopPoll()
            setPhase('login')
            setLoginError(t.error ?? 'Something went wrong.')
            return
          }
          if (t.status === 'done' && t.data) {
            stopPoll()
            setResults(t.data)
            setFilter('')
            setPhase('results')
          }
        } catch {
          /* transient network — keep polling */
        }
      }

      await poll()
      pollIntervalRef.current = window.setInterval(poll, POLL_MS)
    } catch {
      stopPoll()
      setPhase('login')
      setLoginError('Network error. Is the Flask server running on port 5000?')
    }
  }, [stopPoll])

  const applyLoginSuccess = useCallback(
    async (res: { session_id: string; username: string }) => {
      setPendingId(null)
      setVerificationCode('')
      sessionStorage.setItem(SESSION_KEY, res.session_id)
      sessionStorage.setItem(USER_KEY, res.username)
      setLoggedUser(res.username)
      await startFetch()
    },
    [startFetch],
  )

  const pickLoginMethod = (m: LoginMethod) => {
    setLoginError('')
    setLoginMethod(m)
    if (m === 'password') {
      setSessionCookie('')
    } else {
      setPassword('')
      setPendingId(null)
      setVerificationCode('')
    }
  }

  const onSubmitLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoginError('')
    setLoginBusy(true)
    try {
      const body: Record<string, string> = {
        username: username.trim(),
        password,
      }
      if (pendingId) {
        body.pending_id = pendingId
        body.verification_code = verificationCode.trim()
      } else if (verificationCode.trim()) {
        body.verification_code = verificationCode.trim()
      }
      const res = await postJson<LoginResponse>('/api/login', body)
      if (!('ok' in res) || !res.ok) {
        const fail = res as Extract<LoginResponse, { ok: false }>
        if (fail.needs_two_factor && fail.pending_id) {
          setPendingId(fail.pending_id)
          setLoginError(fail.error || 'Enter your two-factor code.')
        } else {
          setPendingId(null)
          setVerificationCode('')
          setLoginError(fail.error || 'Login failed.')
        }
        return
      }
      await applyLoginSuccess(res)
    } catch {
      setLoginError('Network error. Is the server running?')
    } finally {
      setLoginBusy(false)
    }
  }

  const onSubmitSession = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoginError('')
    setLoginBusy(true)
    try {
      const res = await postJson<LoginResponse>('/api/login/session', {
        sessionid: sessionCookie.trim(),
      })
      if (!('ok' in res) || !res.ok) {
        const fail = res as Extract<LoginResponse, { ok: false }>
        setLoginError(fail.error || 'Session login failed.')
        return
      }
      await applyLoginSuccess(res)
    } catch {
      setLoginError('Network error. Is the server running?')
    } finally {
      setLoginBusy(false)
    }
  }

  const cancelTwoFactor = () => {
    setPendingId(null)
    setVerificationCode('')
    setLoginError('')
  }

  const onLogout = async () => {
    stopPoll()
    const sid = sessionStorage.getItem(SESSION_KEY)
    if (sid) {
      await postJson('/api/logout', { session_id: sid }).catch(() => {})
    }
    sessionStorage.removeItem(SESSION_KEY)
    sessionStorage.removeItem(USER_KEY)
    setLoggedUser(null)
    setResults(null)
    setPassword('')
    setVerificationCode('')
    setPendingId(null)
    setLoginError('')
    setSessionCookie('')
    setLoginMethod('password')
    setPhase('login')
  }

  const onRecheck = () => {
    stopPoll()
    setResults(null)
    void startFetch()
  }

  const filtered = useMemo(() => {
    if (!results) return []
    const q = filter.trim().toLowerCase()
    if (!q) return results.non_followers
    return results.non_followers.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        (u.full_name || '').toLowerCase().includes(q),
    )
  }, [results, filter])

  const displayName = loggedUser ?? ''

  return (
    <div className="app-shell">
      {phase === 'login' && (
        <div className="panel-login fade-in">
          <div className="login-card">
            <div className="brand">
              <div className="brand-mark" aria-hidden>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="4" />
                  <circle cx="12" cy="12" r="3.5" />
                </svg>
              </div>
              <div>
                <h1>Unfollow checker</h1>
                <p>Accounts you follow that don’t follow you back. Local-only; credentials stay in memory.</p>
              </div>
            </div>

            <div className="login-tabs" role="tablist" aria-label="Sign-in method">
              <button
                type="button"
                role="tab"
                aria-selected={loginMethod === 'password'}
                className={`tab-btn ${loginMethod === 'password' ? 'active' : ''}`}
                onClick={() => pickLoginMethod('password')}
              >
                Password
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={loginMethod === 'session'}
                className={`tab-btn ${loginMethod === 'session' ? 'active' : ''}`}
                disabled={!!pendingId}
                title={pendingId ? 'Finish two-factor with password first.' : undefined}
                onClick={() => pickLoginMethod('session')}
              >
                Session cookie
              </button>
            </div>

            {pendingId && loginMethod === 'password' && (
              <div className="banner-2fa">
                Two-factor authentication is enabled. Enter the code from your authenticator app, then continue with the
                same password.
              </div>
            )}

            {loginMethod === 'password' ? (
              <form onSubmit={onSubmitLogin}>
                <div className="field">
                  <label htmlFor="u">Username</label>
                  <input
                    id="u"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="p">Password</label>
                  <input
                    id="p"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                {(pendingId || verificationCode) && (
                  <div className="field">
                    <label htmlFor="tfa">Authenticator code</label>
                    <input
                      id="tfa"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="6-digit code"
                      value={verificationCode}
                      onChange={(e) => setVerificationCode(e.target.value)}
                      required={!!pendingId}
                    />
                  </div>
                )}
                <div className="btn-row">
                  <button type="submit" className="btn btn-primary" disabled={loginBusy}>
                    {loginBusy ? 'Please wait…' : pendingId ? 'Verify & continue' : 'Sign in & analyze'}
                  </button>
                  {pendingId && (
                    <button type="button" className="btn btn-ghost" onClick={cancelTwoFactor}>
                      Back
                    </button>
                  )}
                </div>
              </form>
            ) : (
              <form onSubmit={onSubmitSession}>
                <div className="warn-session">
                  <strong>Use only your own Instagram session</strong>
                  Paste the <code style={{ fontSize: '0.85em' }}>sessionid</code> cookie from a browser where you are already
                  logged in at instagram.com. It is as sensitive as a password (whoever has it can use your account). This app
                  keeps it in server RAM only — nothing is written to disk unless you change that yourself elsewhere.
                  Automated access may violate Instagram&apos;s terms.
                </div>
                <div className="field">
                  <label htmlFor="sess">sessionid</label>
                  <textarea
                    id="sess"
                    className="session-textarea"
                    value={sessionCookie}
                    onChange={(e) => setSessionCookie(e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    required
                    placeholder="Paste the cookie value only (often starts with digits)…"
                  />
                </div>
                <div className="btn-row">
                  <button type="submit" className="btn btn-primary" disabled={loginBusy}>
                    {loginBusy ? 'Please wait…' : 'Connect & analyze'}
                  </button>
                </div>
              </form>
            )}

            <div className={`alert-error ${loginError ? 'visible' : ''}`} role="alert">
              {loginError}
            </div>

            <p className="hint">
              {loginMethod === 'password' ? (
                <>
                  Server keeps your session in RAM only (no password saved to disk). Instagram often shows &quot;wrong
                  password&quot; when it actually distrusts the network — try another Wi‑Fi or hotspot before assuming a typo.
                </>
              ) : (
                <>
                  In Chrome: DevTools → Application → Cookies → <code>https://instagram.com</code> → copy the{' '}
                  <code>sessionid</code> value. If login fails, refresh instagram.com in the browser and copy a new value.
                </>
              )}
            </p>
          </div>
        </div>
      )}

      {phase === 'loading' && (
        <div className="panel-loading fade-in">
          <div className="loader-ring" aria-hidden />
          <p className="loading-msg">{loadingMsg}</p>
          <div className="skeleton-board" aria-hidden>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="skel-card" />
            ))}
          </div>
        </div>
      )}

      {phase === 'results' && results && (
        <div className="panel-results fade-in">
          <header className="toolbar">
            <div className="wrap toolbar-inner">
              <div className="user-chip">
                <div className="avatar-sm">{displayName[0]?.toUpperCase() ?? '?'}</div>
                <div>
                  <strong>@{displayName}</strong>
                  <div className="stats" style={{ marginTop: '0.35rem' }}>
                    <span>
                      <strong>{results.followers_count.toLocaleString()}</strong> followers
                    </span>
                    <span>
                      <strong>{results.following_count.toLocaleString()}</strong> following
                    </span>
                    <span className="pill">{results.non_followers.length} not following back</span>
                  </div>
                </div>
              </div>
              <div className="toolbar-actions">
                <button type="button" className="btn btn-primary btn-sm" onClick={onRecheck}>
                  Re-check
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={onLogout}>
                  Log out
                </button>
              </div>
              <div className="search-wrap">
                <input
                  className="search-input"
                  placeholder="Filter by username or name…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  aria-label="Filter accounts"
                />
              </div>
            </div>
          </header>

          <main className="wrap grid-wrap">
            {results.non_followers.length === 0 ? (
              <div className="empty">
                <h2>Everyone follows you back</h2>
                <p>
                  All <strong>{results.following_count.toLocaleString()}</strong> accounts you follow follow you too.
                </p>
              </div>
            ) : filtered.length === 0 ? (
              <div className="empty">
                <p>No accounts match your filter.</p>
              </div>
            ) : (
              <div className="cards">
                {filtered.map((u) => (
                  <UserCard key={u.user_id} user={u} />
                ))}
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  )
}

function UserCard({ user }: { user: NonFollower }) {
  const bg = avatarHue(user.username)
  const initial = (user.username[0] ?? '?').toUpperCase()
  const href = `https://www.instagram.com/${encodeURIComponent(user.username)}/`
  return (
    <article className="card">
      <div className="avatar-lg" style={{ background: bg }}>
        {user.pic ? (
          <img
            src={user.pic}
            alt=""
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        ) : null}
        <span style={{ position: 'relative', zIndex: 0 }}>{initial}</span>
      </div>
      <div className="card-body">
        <a href={href} target="_blank" rel="noopener noreferrer">
          @{user.username}
        </a>
        {user.full_name ? <span className="meta">{user.full_name}</span> : null}
      </div>
    </article>
  )
}
