/**
 * ainotelayer: one way to call GitHub's REST API from the CI scripts.
 *
 * In GitHub Actions it uses GITHUB_TOKEN. With `gh: true` it goes through the
 * `gh` command and its own sign-in instead, to run a script from a developer's
 * machine.
 */
import { execFileSync } from 'node:child_process'

/** The same request through the gh command, which keeps its own sign-in */
function viaGh(pathname, options) {
  const args = ['api', '--method', options.method ?? 'GET', pathname.replace(/^\//, '')]
  if (options.body !== undefined) {
    args.push('--input', '-')
  }
  try {
    const out = execFileSync('gh', args, {
      encoding: 'utf8',
      input: options.body === undefined ? undefined : JSON.stringify(options.body),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return out.trim() === '' ? null : JSON.parse(out)
  } catch (failure) {
    const text = `${failure.stderr ?? ''}${failure.stdout ?? ''}`.trim()
    const error = new Error(`${options.method ?? 'GET'} ${pathname}: ${text}`)
    error.status = Number(/HTTP (\d{3})/.exec(text)?.[1] ?? 0)
    throw error
  }
}

/**
 * Returns `github(pathname, { method, body })`, which resolves to the parsed
 * response and throws an error carrying `status` when GitHub refuses.
 */
export function createGithub({ api, token = '', gh = false } = {}) {
  const base = (api || process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '')
  return async function github(pathname, options = {}) {
    if (gh) {
      return viaGh(pathname, options)
    }
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'ainotelayer' }
    if (token !== '') {
      headers.Authorization = `Bearer ${token}`
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }
    const response = await fetch(`${base}${pathname}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    if (!response.ok) {
      const error = new Error(`${options.method ?? 'GET'} ${pathname}: ${response.status} ${await response.text()}`)
      error.status = response.status
      throw error
    }
    return response.status === 204 ? null : response.json()
  }
}
