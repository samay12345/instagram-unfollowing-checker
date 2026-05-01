/**
 * Playwright collector: user logs in manually, then we open Followers / Following
 * dialogs and merge GraphQL JSON (instagram.com/graphql/query) with DOM link scraping.
 */
import { chromium, type Page, type Response } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { fileURLToPath } from 'url'
import { extractUsersFromPayload, type User } from './extract.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(__dirname, '..', 'out')

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function rlQuestion(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) =>
    rl.question(q, (ans) => {
      rl.close()
      resolve(ans.trim())
    }),
  )
}

async function scrollDialog(page: Page): Promise<void> {
  await page.locator('[role="dialog"]').first().evaluate(() => {
    const root = document.querySelector('[role="dialog"]')
    if (!(root instanceof HTMLElement)) return
    const holder: { el: HTMLElement | null; max: number } = { el: null, max: 0 }
    const walk = (node: Element) => {
      if (!(node instanceof HTMLElement)) return
      const st = getComputedStyle(node)
      const oy = st.overflowY
      if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 60) {
        if (node.scrollHeight >= holder.max) {
          holder.max = node.scrollHeight
          holder.el = node
        }
      }
      const kids = Array.from(node.children)
      for (const c of kids) walk(c)
    }
    walk(root)
    if (holder.el) holder.el.scrollTop = holder.el.scrollHeight
  })
}

async function scrapeDialogDom(page: Page): Promise<User[]> {
  return page.locator('[role="dialog"]').first().evaluate((root) => {
    const USERNAME_RE = /^[a-zA-Z0-9._]{1,30}$/
    const skip = new Set([
      'accounts',
      'explore',
      'reels',
      'stories',
      'direct',
      'p',
      'legal',
      'about',
      'www',
    ])
    const seen = new Set<string>()
    const out: { username: string; id?: string; full_name?: string }[] = []
    root.querySelectorAll('a[href^="/"]').forEach((a) => {
      const href = a.getAttribute('href') || ''
      const m = href.match(/^\/([^/?#]+)\/?$/)
      if (!m) return
      const un = m[1]
      if (!USERNAME_RE.test(un)) return
      if (skip.has(un)) return
      if (seen.has(un)) return
      seen.add(un)
      out.push({ username: un })
    })
    return out
  })
}

async function collectList(page: Page, label: string): Promise<Map<string, User>> {
  const users = new Map<string, User>()

  const onResponse = async (response: Response) => {
    try {
      const url = response.url()
      if (!response.ok()) return
      if (
        !/instagram\.com\/graphql\/query/i.test(url) &&
        !/instagram\.com\/api\/v1\/friendships\//i.test(url)
      ) {
        return
      }
      const ct = (response.headers()['content-type'] || '').toLowerCase()
      if (!ct.includes('json')) return
      const json = await response.json()
      for (const u of extractUsersFromPayload(json)) {
        const key = (u.id || u.username).toLowerCase()
        const prev = users.get(key)
        users.set(key, {
          username: u.username,
          id: u.id ?? prev?.id,
          full_name: u.full_name || prev?.full_name || '',
        })
      }
    } catch {
      /* ignore */
    }
  }

  page.on('response', onResponse)

  let stagnant = 0
  let lastSize = 0
  const maxRounds = 400
  for (let i = 0; i < maxRounds; i++) {
    await scrollDialog(page)
    await delay(880)
    const domBatch = await scrapeDialogDom(page)
    for (const u of domBatch) {
      const key = (u.id || u.username).toLowerCase()
      const prev = users.get(key)
      users.set(key, {
        username: u.username,
        id: u.id ?? prev?.id,
        full_name: u.full_name ?? prev?.full_name ?? '',
      })
    }
    const size = users.size
    process.stdout.write(`\r${label}: ${size} users…`)
    if (size === lastSize) stagnant++
    else stagnant = 0
    lastSize = size
    if (stagnant >= 12) break
  }

  console.log('')
  page.off('response', onResponse)
  return users
}

function toRow(u: User): { username: string; id?: string; full_name?: string } {
  const row: { username: string; id?: string; full_name?: string } = { username: u.username }
  if (u.id) row.id = u.id
  if (u.full_name) row.full_name = u.full_name
  return row
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  console.log('Starting Chromium (visible). Sign in at instagram.com in the opened window.\n')
  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()

  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 120_000 })

  await rlQuestion('When you are logged in and see your feed/home, press Enter here… ')

  const handleRaw = await rlQuestion('Enter your Instagram username (handle only, no @): ')
  const handle = handleRaw.replace(/^@/, '').trim()
  if (!handle) {
    console.error('Username is required.')
    await browser.close()
    process.exit(1)
  }

  await page.goto(`https://www.instagram.com/${encodeURIComponent(handle)}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 120_000,
  })
  await delay(2500)

  console.log('\nOpening Followers…')
  await page
    .locator(`a[href="/${handle}/followers/"]`)
    .first()
    .click({ timeout: 25_000 })
    .catch(async () => {
      await page.getByRole('link', { name: /followers/i }).first().click({ timeout: 15_000 })
    })

  await page.waitForSelector('[role="dialog"]', { timeout: 25_000 })
  const followersMap = await collectList(page, 'Followers')
  await page.keyboard.press('Escape')
  await delay(600)

  console.log('Opening Following…')
  await page
    .locator(`a[href="/${handle}/following/"]`)
    .first()
    .click({ timeout: 25_000 })
    .catch(async () => {
      await page.getByRole('link', { name: /following/i }).first().click({ timeout: 15_000 })
    })

  await page.waitForSelector('[role="dialog"]', { timeout: 25_000 })
  const followingMap = await collectList(page, 'Following')

  await browser.close()

  const followers = [...followersMap.values()].map(toRow).sort((a, b) => a.username.localeCompare(b.username))
  const following = [...followingMap.values()].map(toRow).sort((a, b) => a.username.localeCompare(b.username))

  const followerNames = new Set(followers.map((u) => u.username.toLowerCase()))
  const nonFollowers = following.filter((u) => !followerNames.has(u.username.toLowerCase()))

  fs.writeFileSync(path.join(OUT_DIR, 'followers.json'), JSON.stringify(followers, null, 2), 'utf8')
  fs.writeFileSync(path.join(OUT_DIR, 'following.json'), JSON.stringify(following, null, 2), 'utf8')
  fs.writeFileSync(path.join(OUT_DIR, 'non_followers.json'), JSON.stringify(nonFollowers, null, 2), 'utf8')
  fs.writeFileSync(
    path.join(OUT_DIR, 'meta.json'),
    JSON.stringify(
      { profile_username: handle, exported_at: new Date().toISOString(), collector: 'iguc-playwright' },
      null,
      2,
    ),
    'utf8',
  )

  console.log(`\nWrote JSON under ${OUT_DIR}`)
  console.log(`Followers: ${followers.length}, Following: ${following.length}, Not following back: ${nonFollowers.length}`)

  if (process.argv.includes('--upload')) {
    const base = (process.env.IGUC_API_BASE || 'http://127.0.0.1:5000').replace(/\/$/, '')
    const res = await fetch(`${base}/api/import-lists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ followers, following }),
    })
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    if (!res.ok || !body.ok) {
      console.error('Upload failed:', body.error || res.statusText)
      process.exitCode = 1
    } else {
      console.log(`Uploaded to ${base}/api/import-lists (open the app → Browser import is optional if you upload here).`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
