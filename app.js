const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const TENANT_ID = "kkr";
const OTP_CODE = "123456";
const OTP_TTL_SECONDS = 180;
const ACCESS_TOKEN_TTL_SECONDS = 900;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const otpSessions = new Map();
const refreshTokens = new Set();

app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "views", "home.html"));
});

app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "views", "dashboard.html"));
});

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function makeTokenPayload({ fanId, email, tenantId, ttlSeconds }) {
  const now = Math.floor(Date.now() / 1000);
  return {
    fan_id: fanId,
    email,
    tenant_id: tenantId,
    iat: now,
    exp: now + ttlSeconds,
  };
}

function makeDummyJwt(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  return [
    base64UrlEncode(JSON.stringify(header)),
    base64UrlEncode(JSON.stringify(payload)),
    "dummy-signature",
  ].join(".");
}

function getGlobalErrorMessage(status, fallbackMessage, errorField) {
  if (status >= 500) return { error: "Something went wrong. Please try again." };
  if (status >= 400 && errorField) return { error: errorField };
  return { error: fallbackMessage };
}

app.post("/api/auth/otp/send", (req, res) => {
  try {
    const email = String(req.body?.email || "").trim();
    const tenantId = String(req.body?.tenant_id || "");

    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const expiresAt = Date.now() + OTP_TTL_SECONDS * 1000;
    otpSessions.set(email, {
      email,
      tenantId: tenantId || TENANT_ID,
      otp: OTP_CODE,
      expiresAt,
    });

    return res.status(200).json({
      status: "otp_sent",
      message: "OTP sent to your email",
      expires_in: OTP_TTL_SECONDS,
      _dummy_note: "Use OTP 123456 to verify",
    });
  } catch (_error) {
    return res.status(500).json(getGlobalErrorMessage(500, "Failed to send OTP"));
  }
});

app.post("/api/auth/otp/verify", (req, res) => {
  const email = String(req.body?.email || "").trim();
  const otp = String(req.body?.otp || "").trim();
  const tenantId = String(req.body?.tenant_id || TENANT_ID);
  const session = otpSessions.get(email);

  if (!session || Date.now() > session.expiresAt) {
    otpSessions.delete(email);
    return res.status(400).json({ error: "No OTP session found. Please request a new OTP." });
  }

  if (otp !== OTP_CODE) {
    return res.status(401).json({ error: "Invalid OTP. (Dummy mode: use 123456)" });
  }

  const fanId = "dummy-fan-uuid-5678";
  const payload = makeTokenPayload({
    fanId,
    email,
    tenantId,
    ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
  });
  const accessToken = makeDummyJwt(payload);
  const refreshToken = "dummy-refresh-token-uuid-1234";
  refreshTokens.add(refreshToken);
  otpSessions.delete(email);

  return res.status(200).json({
    access_token: accessToken,
    refresh_token: refreshToken,
    fan_id: fanId,
    email,
    tenant_id: tenantId,
    is_new_user: true,
  });
});

app.get("/api/auth/social/url", (req, res) => {
  const tenantId = String(req.query?.tenant_id || TENANT_ID);
  const provider = String(req.query?.provider || "google");

  const url =
    `http://localhost:${PORT}/api/auth/social/callback?code=dummy-auth-code` +
    `&tenant_id=${encodeURIComponent(tenantId)}` +
    `&provider=${encodeURIComponent(provider)}`;

  return res.status(200).json({
    url,
    _dummy_note: "Real URL active once Cognito is configured in .env",
  });
});

app.get("/api/auth/social/callback", (req, res) => {
  const tenantId = String(req.query?.tenant_id || TENANT_ID);
  const fanId = "dummy-fan-uuid-5678";
  const email = "social.user@example.com";
  const payload = makeTokenPayload({
    fanId,
    email,
    tenantId,
    ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
  });
  const token = makeDummyJwt(payload);
  const redirectUrl = `/dashboard?token=${encodeURIComponent(token)}&fan_id=${encodeURIComponent(fanId)}&is_new_user=true`;

  return res.redirect(302, redirectUrl);
});

app.post("/api/auth/token/refresh", (req, res) => {
  const refreshToken = String(req.body?.refresh_token || "").trim();
  if (!refreshToken || !refreshTokens.has(refreshToken)) {
    return res.status(401).json({ error: "Refresh token expired or revoked" });
  }

  const payload = makeTokenPayload({
    fanId: "dummy-fan-uuid-5678",
    email: "user@example.com",
    tenantId: TENANT_ID,
    ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
  });
  return res.status(200).json({
    access_token: makeDummyJwt(payload),
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
  });
});

app.post("/api/auth/logout", (req, res) => {
  const refreshToken = String(req.body?.refresh_token || "").trim();
  if (refreshToken) {
    refreshTokens.delete(refreshToken);
  }
  return res.status(200).json({ status: "logged_out" });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
