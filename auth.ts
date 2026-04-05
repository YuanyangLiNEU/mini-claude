/**
 * OAuth credential handling for the Claude Code subscription token.
 *
 * Reads the access token from macOS Keychain (same place `claude` CLI stores it).
 * Refreshes automatically when the token is near expiry.
 *
 * Reference: claude-code src/utils/auth.ts + src/services/oauth/client.ts
 */

import { $ } from 'bun'

// From claude-code src/constants/oauth.ts:91-99 (prod config)
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
// From claude-code src/constants/oauth.ts:36 — required for OAuth on /v1/messages
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

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
  const raw = await $`security find-generic-password -s ${KEYCHAIN_SERVICE} -w`
    .quiet()
    .text()
  return JSON.parse(raw.trim()) as Credentials
}

async function writeKeychain(creds: Credentials): Promise<void> {
  const json = JSON.stringify(creds)
  // -U = update if exists; -a = account (we preserve existing account name)
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
    subscriptionType: 'max', // will be overwritten below from existing creds
  }
}

/**
 * Get a valid access token. Refreshes automatically if the current token
 * is expired or will expire within 60 seconds.
 */
export async function getAccessToken(): Promise<string> {
  const creds = await readKeychain()
  const { accessToken, refreshToken, expiresAt } = creds.claudeAiOauth

  // Refresh if expired or expiring soon
  const safetyWindowMs = 60_000
  if (expiresAt > Date.now() + safetyWindowMs) {
    return accessToken
  }

  console.error('[auth] Token expired or expiring soon, refreshing...')
  const refreshed = await refreshAccessToken(refreshToken)
  // Preserve subscriptionType from existing creds
  refreshed.subscriptionType = creds.claudeAiOauth.subscriptionType
  creds.claudeAiOauth = refreshed
  await writeKeychain(creds)
  console.error('[auth] Token refreshed.')
  return refreshed.accessToken
}
