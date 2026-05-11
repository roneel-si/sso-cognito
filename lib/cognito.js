require("./load-env");
const crypto = require("crypto");
const {
	CognitoIdentityProviderClient,
	InitiateAuthCommand,
	RespondToAuthChallengeCommand,
	AdminCreateUserCommand,
} = require("@aws-sdk/client-cognito-identity-provider");

function computeSecretHash(username, clientId, clientSecret) {
	return crypto
		.createHmac("sha256", clientSecret)
		.update(username + clientId)
		.digest("base64");
}

function getCognitoClient() {
	const region =
		process.env.AWS_REGION || process.env.COGNITO_REGION || "us-east-1";
	return new CognitoIdentityProviderClient({ region });
}

function getPoolClientConfig() {
	const clientId = String(
		process.env.COGNITO_CLIENT_ID ||
			process.env.COGNITO_USER_POOL_CLIENT_ID ||
			"",
	).trim();
	const clientSecret = String(
		process.env.COGNITO_CLIENT_SECRET ||
			process.env.COGNITO_USER_POOL_CLIENT_SECRET ||
			"",
	).trim();
	if (!clientId) {
		const err = new Error(
			"Missing Cognito app client id: set COGNITO_CLIENT_ID or COGNITO_USER_POOL_CLIENT_ID (e.g. in project .env next to app.js).",
		);
		err.code = "COGNITO_CONFIG";
		throw err;
	}
	return { clientId, clientSecret };
}

function withSecretHash(authParameters, username, clientId, clientSecret) {
	if (clientSecret) {
		return {
			...authParameters,
			SECRET_HASH: computeSecretHash(username, clientId, clientSecret),
		};
	}
	return authParameters;
}

/**
 * Starts Cognito email OTP: sends the code to the user's email.
 * Returns { session, challengeName, challengeParameters } for a later RespondToAuthChallenge (verify step).
 */
async function initiateEmailOtpOld(email) {
	const { clientId, clientSecret } = getPoolClientConfig();
	const client = getCognitoClient();

	const baseParams = withSecretHash(
		{
			USERNAME: email,
			PREFERRED_CHALLENGE: "EMAIL_OTP",
		},
		email,
		clientId,
		clientSecret,
	);

	let response = await client.send(
		new InitiateAuthCommand({
			ClientId: clientId,
			AuthFlow: "CUSTOM_AUTH",
			AuthParameters: baseParams,
		}),
	);

	if (response.ChallengeName === "SELECT_CHALLENGE" && response.Session) {
		const availableChallenges = response.AvailableChallenges || [];

		if (!availableChallenges.includes("EMAIL_OTP")) {
			const err = new Error(
				`EMAIL_OTP is not available for this user. Available challenges: ${availableChallenges.join(", ") || "none"}. ` +
					`Check: 1) User pool has EMAIL_OTP sign-in enabled, 2) App client allows ALLOW_USER_AUTH, ` +
					`3) User pool is Essentials tier or higher, 4) User has verified email.`,
			);
			err.code = "EMAIL_OTP_NOT_AVAILABLE";
			err.availableChallenges = availableChallenges;
			throw err;
		}

		const selectResponses = withSecretHash(
			{
				USERNAME: email,
				ANSWER: "EMAIL_OTP",
			},
			email,
			clientId,
			clientSecret,
		);
		response = await client.send(
			new RespondToAuthChallengeCommand({
				ClientId: clientId,
				ChallengeName: "SELECT_CHALLENGE",
				Session: response.Session,
				ChallengeResponses: selectResponses,
			}),
		);
	}

	if (!response.Session) {
		const err = new Error("Cognito did not return an auth session.");
		err.code = "COGNITO_UNEXPECTED";
		throw err;
	}

	return {
		session: response.Session,
		challengeName: response.ChallengeName,
		challengeParameters: response.ChallengeParameters || {},
		authenticationResult: response.AuthenticationResult,
	};
}

async function initiateEmailOtp(email) {
	const { clientId, clientSecret } = getPoolClientConfig();
	const client = getCognitoClient();

	// Step 1 — ensure user exists in Cognito
	try {
		console.log("Creating user in Cognito");
		await client.send(
			new AdminCreateUserCommand({
				UserPoolId: process.env.COGNITO_USER_POOL_ID,
				Username: email,
				MessageAction: "SUPPRESS",
				UserAttributes: [
					{ Name: "email", Value: email },
					{ Name: "email_verified", Value: "true" },
				],
			}),
		);
	} catch (err) {
		console.log("Error creating user in Cognito", err);
		if (err.name !== "UsernameExistsException") throw err;
		// User already exists — fine, continue
	}

	console.log("User created in Cognito");
	// Step 2 — start custom auth flow
	// This triggers your Define + Create Lambda chain
	const response = await client.send(
		new InitiateAuthCommand({
			ClientId: clientId,
			AuthFlow: "CUSTOM_AUTH",
			AuthParameters: {
				USERNAME: email,
				// include secret hash if your app client has a secret
				SECRET_HASH: computeSecretHash(email, clientId, clientSecret),
			},
		}),
	);
	console.log("Custom auth flow initiated in Cognito");

	if (!response.Session) {
		throw new Error("Cognito did not return a session");
	}

	return {
		session: response.Session,
		challengeName: response.ChallengeName,
		challengeParameters: response.ChallengeParameters || {},
	};
}

function mapCognitoSendError(error) {
	if (error.code === "COGNITO_CONFIG") {
		return { status: 503, message: error.message };
	}
	if (error.code === "EMAIL_OTP_NOT_AVAILABLE") {
		return { status: 400, message: error.message };
	}
	const name = error.name || "";
	switch (name) {
		case "UserNotFoundException":
			return { status: 400, message: "No account found for this email." };
		case "UserLambdaValidationException":
		case "InvalidParameterException":
			return {
				status: 400,
				message: error.message || "Invalid sign-in request.",
			};
		case "NotAuthorizedException":
			return {
				status: 400,
				message:
					error.message || "Unable to send a code to this email.",
			};
		case "TooManyRequestsException":
			return {
				status: 429,
				message: "Too many attempts. Please wait and try again.",
			};
		case "ForbiddenException":
			return {
				status: 403,
				message: "Request blocked. Check user pool WAF or policies.",
			};
		default:
			if (error.code === "COGNITO_UNEXPECTED") {
				return { status: 502, message: error.message };
			}
			return {
				status: 500,
				message: "Something went wrong. Please try again.",
			};
	}
}

async function verifyEmailOtp(email, otp, cognitoSession) {
	const { clientId, clientSecret } = getPoolClientConfig();
	const client = getCognitoClient();

	let result;
	try {
		result = await client.send(
			new RespondToAuthChallengeCommand({
				ClientId: clientId,
				ChallengeName: "CUSTOM_CHALLENGE",
				Session: cognitoSession,
				ChallengeResponses: {
					USERNAME: email,
					ANSWER: otp,
					SECRET_HASH: computeSecretHash(
						email,
						clientId,
						clientSecret,
					),
				},
			}),
		);
	} catch (err) {
		if (err.name === "NotAuthorizedException") {
			const e = new Error("Invalid or expired OTP.");
			e.code = "OTP_INVALID";
			throw e;
		}
		if (err.name === "ExpiredCodeException") {
			const e = new Error("OTP has expired. Please request a new one.");
			e.code = "OTP_EXPIRED";
			throw e;
		}
		throw err;
	}

	// If AuthenticationResult is absent, OTP was wrong
	if (!result.AuthenticationResult) {
		const e = new Error("Invalid OTP. Please try again.");
		e.code = "OTP_INVALID";
		throw e;
	}

	// Decode Cognito ID Token to get user details
	const idToken = result.AuthenticationResult.IdToken;
	const idTokenPayload = JSON.parse(
		Buffer.from(idToken.split(".")[1], "base64").toString(),
	);

	return {
		cognitoUserId: idTokenPayload.sub,
		email: idTokenPayload.email,
		idToken: result.AuthenticationResult.IdToken,
		accessToken: result.AuthenticationResult.AccessToken,
		refreshToken: result.AuthenticationResult.RefreshToken,
	};
}

module.exports = {
	initiateEmailOtp,
	mapCognitoSendError,
	verifyEmailOtp,
};
