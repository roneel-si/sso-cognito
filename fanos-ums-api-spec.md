# FanOS — API + UI Spec (Single Server)
## For Claude Code: Wire the UI to the API endpoints

---

## Architecture

Single Node.js / Express server on **port 3000**.
Same server serves both the HTML pages and the API routes.

```
http://localhost:3000/              → homepage
http://localhost:3000/login         → login page (Email + Social tabs)
http://localhost:3000/dashboard     → post-login page
http://localhost:3000/api/auth/*    → API endpoints
```

No CORS needed. No separate frontend server. All fetch() calls use
relative paths (e.g. fetch('/api/auth/otp/send')).

---

## Pages

### GET /
Homepage. Has a "Login / Register" button → navigates to /login.

### GET /login
Login page with two tabs: Email and Social. Already built in the UI.

### GET /dashboard
Post-login page. Shows decoded fan info from JWT. Has logout button.
**Guard:** if no `fanos_token` in localStorage → redirect to /login immediately.

---

## UI States — Login Page

```
Email tab:
  IDLE      → email input + "Send code" button
  OTP_SENT  → OTP input + "Verify" button + countdown timer
  LOADING   → spinner on active button, all inputs disabled
  ERROR     → inline error message, form stays as-is
  SUCCESS   → redirect to /dashboard

Social tab:
  IDLE        → "Continue with Google" button
  LOADING     → button disabled + "Redirecting..."
  REDIRECTING → window.location.href = url
```

---

## API Endpoints

All fetch calls use relative URLs since UI and API are on the same server.

---

### 1 — POST /api/auth/otp/send

Triggered by: "Send code" button on Email tab.

**Request body**
```json
{
  "email": "user@example.com",
  "tenant_id": "kkr"
}
```

**Success — 200**
```json
{
  "status": "otp_sent",
  "message": "OTP sent to your email",
  "expires_in": 180,
  "_dummy_note": "Use OTP 123456 to verify"
}
```

**Errors**
```json
{ "error": "Invalid email format" }   // 400
{ "error": "Failed to send OTP" }     // 500
```

**UI behaviour**
- Button shows loading spinner while request is in flight
- 200 → switch to OTP_SENT state:
  - Hide email input + Send button
  - Show OTP input + Verify button
  - Show "Code sent to {email}" label
  - Start 3:00 countdown timer (format MM:SS)
  - Show "Resend code" link, disabled for first 30s then enabled
- Error → show `error` field inline below the email input, stay in IDLE

---

### 2 — POST /api/auth/otp/verify

Triggered by: "Verify" button after user types OTP.

**Request body**
```json
{
  "email": "user@example.com",
  "otp": "123456",
  "tenant_id": "kkr"
}
```

**Success — 200**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJmYW5faWQiOiJkdW1teS1mYW4tdXVpZC01Njc4IiwiZW1haWwiOiJ1c2VyQGV4YW1wbGUuY29tIiwidGVuYW50X2lkIjoia2tyIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjk5OTk5OTk5OTl9.dummy",
  "refresh_token": "dummy-refresh-token-uuid-1234",
  "fan_id": "dummy-fan-uuid-5678",
  "email": "user@example.com",
  "tenant_id": "kkr",
  "is_new_user": true
}
```

**Errors**
```json
{ "error": "Invalid OTP. (Dummy mode: use 123456)" }            // 401
{ "error": "No OTP session found. Please request a new OTP." }  // 400
```

**UI behaviour**
- Verify button shows loading spinner
- 200 →
  - localStorage.setItem('fanos_token', data.access_token)
  - localStorage.setItem('fanos_refresh_token', data.refresh_token)
  - localStorage.setItem('fanos_fan_id', data.fan_id)
  - window.location.href = '/dashboard'
- 401 → show "Incorrect code. Try again." inline, clear OTP input, refocus it
- 400 → show "Session expired. Please request a new code.",
         reset to IDLE state (show email input again)

---

### 3 — GET /api/auth/social/url

Triggered by: "Continue with Google" button on Social tab.

**Request**
```
GET /api/auth/social/url?tenant_id=kkr&provider=google
```
No body.

**Success — 200**
```json
{
  "url": "https://YOUR-COGNITO-DOMAIN.auth.ap-south-1.amazoncognito.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&response_type=code&scope=email+openid+profile&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Fauth%2Fsocial%2Fcallback&identity_provider=Google",
  "_dummy_note": "Real URL active once Cognito is configured in .env"
}
```

**UI behaviour**
- Button shows "Redirecting..." and is disabled while fetching
- 200 → window.location.href = data.url
- Error → show "Google login unavailable. Please use email login."

---

### 4 — GET /api/auth/social/callback

NOT called by the UI. Cognito redirects the browser here after Google login.
The server handles it and redirects to /dashboard.

**Incoming (from Cognito)**
```
GET /api/auth/social/callback?code=AUTHORIZATION_CODE
```

**Server response (dummy mode) — 302 Redirect**
```
Location: /dashboard?token=eyJ...&fan_id=dummy-uuid&is_new_user=true
```

**Dashboard page — on load**
```javascript
// 1. Check for token in URL (coming from social login)
const params = new URLSearchParams(window.location.search);
const urlToken = params.get('token');
if (urlToken) {
  localStorage.setItem('fanos_token', urlToken);
  localStorage.setItem('fanos_fan_id', params.get('fan_id'));
  window.history.replaceState({}, '', '/dashboard'); // clean URL
}

// 2. Guard — redirect if still no token
if (!localStorage.getItem('fanos_token')) {
  window.location.href = '/login';
}

// 3. Decode token and show fan info
function decodeToken(token) {
  return JSON.parse(atob(token.split('.')[1]));
}
const { fan_id, email, tenant_id } = decodeToken(localStorage.getItem('fanos_token'));
// Display fan_id, email, tenant_id on the page
```

---

### 5 — POST /api/auth/token/refresh

Called silently by the UI when the access token is near expiry.
Not tied to any button — runs in background.

**Request body**
```json
{ "refresh_token": "dummy-refresh-token-uuid-1234" }
```

**Success — 200**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.new-token",
  "expires_in": 900
}
```

**Error — 401**
```json
{ "error": "Refresh token expired or revoked" }
```

**UI behaviour**
- 200 → localStorage.setItem('fanos_token', data.access_token)
- 401 → clear all fanos_* localStorage keys → window.location.href = '/login'

---

### 6 — POST /api/auth/logout

Triggered by: logout button on dashboard.

**Request body**
```json
{ "refresh_token": "dummy-refresh-token-uuid-1234" }
```

**Success — 200**
```json
{ "status": "logged_out" }
```

**UI behaviour — always, regardless of server response**
```javascript
localStorage.removeItem('fanos_token');
localStorage.removeItem('fanos_refresh_token');
localStorage.removeItem('fanos_fan_id');
window.location.href = '/';
```

---

## localStorage Reference

| Key | Value | Set by |
|-----|-------|--------|
| fanos_token | JWT access token | /otp/verify, /social/callback |
| fanos_refresh_token | Opaque string | /otp/verify |
| fanos_fan_id | UUID string | /otp/verify, /social/callback |

---

## Decoding the JWT

```javascript
function decodeToken(token) {
  return JSON.parse(atob(token.split('.')[1]));
}
// Payload shape:
// { fan_id, email, tenant_id, iat, exp }
```

---

## Error Handling — Global Rules

1. fetch() throws (network down) → show "Connection error. Please try again."
2. 5xx response → show "Something went wrong. Please try again."
3. 4xx response → show the `error` field from the response JSON
4. Never clear the form on error — let the user fix and retry
5. Disable all buttons while a request is in flight
6. Re-enable buttons after response regardless of outcome

---

## Dummy Test Credentials

| | Value |
|-|-------|
| OTP (always valid in dummy mode) | 123456 |
| tenant_id (hardcoded for POC) | kkr |
| Email | any valid format |

---

## Prompt for Claude Code

> Read this file. The Node.js server at localhost:3000 serves both the HTML
> pages and the API. Wire the login page UI to the 6 API endpoints defined
> in this spec. Use relative fetch paths (no http://localhost:3000 prefix).
> Implement all UI states, error messages, loading states, localStorage
> writes, and redirects exactly as specified. The dummy server is already
> running. Test OTP is 123456. Do not modify any server-side files.
