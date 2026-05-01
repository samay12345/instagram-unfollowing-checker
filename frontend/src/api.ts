export type LoginResponse =
  | {
      ok: true
      session_id: string
      username: string
    }
  | {
      ok: false
      error: string
      needs_two_factor?: boolean
      pending_id?: string
    }

export type FetchStartResponse =
  | { ok: true; task_id: string }
  | { ok: false; error: string }

export type TaskResponse =
  | { status: 'not_found' }
  | {
      status: 'running' | 'done' | 'error'
      msg?: string
      data?: FetchResultPayload
      error?: string | null
    }

export type NonFollower = {
  user_id: string
  username: string
  full_name: string
  pic: string
}

export type FetchResultPayload = {
  non_followers: NonFollower[]
  followers_count: number
  following_count: number
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json() as Promise<T>
}

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path)
  return r.json() as Promise<T>
}
