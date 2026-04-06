/**
 * Authentication for the Anthropic Messages API.
 *
 * Supports two modes:
 *   1. API key (standard) — set ANTHROPIC_API_KEY env var
 *   2. OAuth (Claude Max/Pro) — reads token from macOS Keychain
 *
 * API key is checked first. If not set, falls back to OAuth.
 *
 * Reference: claude-code src/utils/auth.ts + src/services/oauth/client.ts
 */

import { makeLogger } from './debug.ts'

const log = makeLogger('auth')

// ── Auth mode detection ─────────────────────────────────────────────────────

export type AuthMode = 'api_key' | 'oauth'

export function getAuthMode(): AuthMode {
  return process.env.ANTHROPIC_API_KEY ? 'api_key' : 'oauth'
}

/**
 * Get auth headers for the API request. Returns the appropriate headers
 * based on whether an API key or OAuth token is being used.
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (apiKey) {
    log.debug('using API key auth')
    return { 'x-api-key': apiKey }
  }

  // OAuth path — read from macOS Keychain
  const token = await getOAuthAccessToken()
  return {
    'Authorization': `Bearer ${token}`,
    'anthropic-beta': OAUTH_BETA_HEADER,
  }
}

// ── OAuth (macOS Keychain) ──────────────────────────────────────────────────

// From claude-code src/constants/oauth.ts:91-99 (prod config)
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
// From claude-code src/constants/oauth.ts:36 — required for OAuth on /v1/messages
const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

// Keychain service name used by claude-code on macOS
const KEYCHAIN_SERVICE = 'Claude Code-credentials'

type Credentials = {
  claudeAiOauth: {
    accessToken: string
    refreshToken: string
    expiresAt: number // ms since epoch
    scopes: string[]
    subscriptionType: string
  }
}

async function readKeychain(): Promise<Credentials> {
  const { $ } = await import('bun')
  const raw = await $`security find-generic-password -s ${KEYCHAIN_SERVICE} -w`
    .quiet()
    .text()
  return JSON.parse(raw.trim()) as Credentials
}

async function writeKeychain(creds: Credentials): Promise<void> {
  const { $ } = await import('bun')
  const json = JSON.stringify(creds)
  const account = process.env.USER ?? 'user'
  await $`security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -w ${json}`
    .quiet()
}

type TokenRefreshResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
}

async function refreshAccessToken(refreshToken: string): Promise<Credentials['claudeAiOauth']> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`)
  }
  const data = (await response.json()) as TokenRefreshResponse
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: data.scope?.split(' ') ?? [],
    subscriptionType: 'max',
  }
}

/**
 * Get a valid OAuth access token. Refreshes automatically if the current
 * token is expired or will expire within 60 seconds.
 */
async function getOAuthAccessToken(): Promise<string> {
  const creds = await readKeychain()
  const { accessToken, refreshToken, expiresAt } = creds.claudeAiOauth

  const safetyWindowMs = 60_000
  const msRemaining = expiresAt - Date.now()
  if (msRemaining > safetyWindowMs) {
    log.debug('using cached token', { expiresInSec: Math.floor(msRemaining / 1000) })
    return accessToken
  }

  log.info('token expired or expiring soon, refreshing')
  const refreshed = await refreshAccessToken(refreshToken)
  refreshed.subscriptionType = creds.claudeAiOauth.subscriptionType
  creds.claudeAiOauth = refreshed
  await writeKeychain(creds)
  log.info('token refreshed', { newExpiresInSec: Math.floor((refreshed.expiresAt - Date.now()) / 1000) })
  return refreshed.accessToken
}
