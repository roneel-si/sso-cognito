require("./lib/load-env");
const path = require("path");

const express = require("express");
const {
	initiateEmailOtp,
	mapCognitoSendError,
	verifyEmailOtp,
} = require("./lib/cognito");

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

app.get("/flow", (_req, res) => {
	res.sendFile(path.join(__dirname, "views", "flow.html"));
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
	if (status >= 500)
		return { error: "Something went wrong. Please try again." };
	if (status >= 400 && errorField) return { error: errorField };
	return { error: fallbackMessage };
}

app.post("/api/auth/otp/send", async (req, res) => {
	try {
		const email = String(req.body?.email || "").trim();
		const tenantId = String(req.body?.tenant_id || "");

		if (!EMAIL_REGEX.test(email)) {
			return res.status(400).json({ error: "Invalid email format" });
		}

		let cognitoResult;
		try {
			cognitoResult = await initiateEmailOtp(email);
		} catch (cognitoError) {
			const mapped = mapCognitoSendError(cognitoError);
			return res.status(mapped.status).json({ error: mapped.message });
		}

		if (cognitoResult.challengeName !== "CUSTOM_CHALLENGE") {
			return res.status(502).json({
				error: "Unexpected Cognito response. Ensure the app client allows USER_AUTH and the user pool supports email OTP sign-in.",
			});
		}

		const expiresInSeconds = OTP_TTL_SECONDS;
		const serverSessionMs = 15 * 60 * 1000;
		const expiresAt = Date.now() + serverSessionMs;

		otpSessions.set(email, {
			email,
			tenantId: tenantId || TENANT_ID,
			cognitoSession: cognitoResult.session,
			expiresAt,
		});

		return res.status(200).json({
			status: "otp_sent",
			message: "OTP sent to your email",
			expires_in: expiresInSeconds,
		});
	} catch (_error) {
		return res
			.status(500)
			.json(getGlobalErrorMessage(500, "Failed to send OTP"));
	}
});

app.post("/api/auth/otp/verify123", (req, res) => {
	const email = String(req.body?.email || "").trim();
	const otp = String(req.body?.otp || "").trim();
	const tenantId = String(req.body?.tenant_id || TENANT_ID);
	const session = otpSessions.get(email);

	if (!session || Date.now() > session.expiresAt) {
		otpSessions.delete(email);
		return res
			.status(400)
			.json({ error: "No OTP session found. Please request a new OTP." });
	}

	if (session.cognitoSession) {
		return res.status(503).json({
			error: "OTP verification is not wired to Cognito yet. This build only sends the email code; confirm delivery first, then we can add RespondToAuthChallenge.",
		});
	}

	if (otp !== OTP_CODE) {
		return res
			.status(401)
			.json({ error: "Invalid OTP. (Dummy mode: use 123456)" });
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

app.post("/api/auth/otp/verify", async (req, res) => {
	const email = String(req.body?.email || "").trim();
	const otp = String(req.body?.otp || "").trim();
	const tenantId = String(req.body?.tenant_id || TENANT_ID);

	// ── Check session exists and is not expired ────────────
	const session = otpSessions.get(email);
	if (!session || Date.now() > session.expiresAt) {
		otpSessions.delete(email);
		return res.status(400).json({
			error: "No OTP session found. Please request a new OTP.",
		});
	}

	// ── Validate OTP format ────────────────────────────────
	if (!/^\d{6}$/.test(otp)) {
		return res.status(400).json({ error: "OTP must be a 6-digit number." });
	}

	try {
		// ── Verify OTP with Cognito ────────────────────────
		let cognitoUser;
		try {
			cognitoUser = await verifyEmailOtp(
				email,
				otp,
				session.cognitoSession,
			);
		} catch (err) {
			if (err.code === "OTP_INVALID" || err.code === "OTP_EXPIRED") {
				return res.status(401).json({ error: err.message });
			}
			throw err;
		}

		// ── TODO: look up or create fan in PostgreSQL ──────
		// Replace these two lines when DB is connected:
		// const fan = await resolveOrCreateFan(cognitoUser.email, cognitoUser.cognitoUserId, tenantId);
		const fanId = cognitoUser.cognitoUserId;
		const isNewUser = true;

		// ── Mint FanOS JWT ─────────────────────────────────
		const payload = makeTokenPayload({
			fanId,
			email: cognitoUser.email,
			tenantId,
			ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
		});
		const accessToken = makeDummyJwt(payload);

		// ── Store refresh token + clean up session ─────────
		refreshTokens.add(cognitoUser.refreshToken);
		otpSessions.delete(email);

		return res.status(200).json({
			access_token: accessToken,
			refresh_token: cognitoUser.refreshToken,
			fan_id: fanId,
			email: cognitoUser.email,
			tenant_id: tenantId,
			is_new_user: isNewUser,
		});
	} catch (err) {
		console.error("[verifyOtp] Error:", err);
		return res.status(500).json({ error: "Failed to verify OTP." });
	}
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
		return res
			.status(401)
			.json({ error: "Refresh token expired or revoked" });
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
