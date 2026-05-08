(function () {
  const TENANT_ID = "kkr";
  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const tabEmail = document.getElementById("tab-email");
  const tabSocial = document.getElementById("tab-social");
  const panelEmail = document.getElementById("panel-email");
  const panelSocial = document.getElementById("panel-social");

  const authError = document.getElementById("auth-error");
  const stepEmail = document.getElementById("email-step-1");
  const stepOtp = document.getElementById("email-step-2");
  const emailInput = document.getElementById("login-email");
  const emailHidden = document.getElementById("login-email-hidden");
  const emailDisplay = document.getElementById("email-display");
  const otpCountdown = document.getElementById("otp-countdown");
  const btnSendCode = document.getElementById("btn-send-code");
  const btnVerifyOtp = document.getElementById("btn-verify-otp");
  const btnChangeEmail = document.getElementById("btn-change-email");
  const btnResendOtp = document.getElementById("btn-resend-otp");
  const btnGoogleLogin = document.getElementById("btn-google-login");
  const otpForm = document.getElementById("form-verify-otp");
  const otpInput = document.getElementById("login-otp");

  let activeRequestCount = 0;
  let currentEmail = "";
  let resendAllowedAt = 0;
  let expiryIntervalId = null;
  let resendIntervalId = null;
  let activeLoadingButton = null;
  let activeLoadingButtonText = "";
  let activeGoogleText = "";

  function setTab(activeTab) {
    const isEmail = activeTab === "email";
    if (!tabEmail || !tabSocial || !panelEmail || !panelSocial) return;

    tabEmail.setAttribute("aria-selected", isEmail ? "true" : "false");
    tabEmail.tabIndex = isEmail ? 0 : -1;
    tabSocial.setAttribute("aria-selected", isEmail ? "false" : "true");
    tabSocial.tabIndex = isEmail ? -1 : 0;
    panelEmail.toggleAttribute("hidden", !isEmail);
    panelSocial.toggleAttribute("hidden", isEmail);
  }

  function showError(message) {
    if (!authError) return;
    authError.textContent = message;
    authError.hidden = false;
  }

  function clearError() {
    if (!authError) return;
    authError.textContent = "";
    authError.hidden = true;
  }

  function formatCountdown(totalSeconds) {
    const clamped = Math.max(0, totalSeconds);
    const minutes = Math.floor(clamped / 60);
    const seconds = clamped % 60;
    return String(minutes) + ":" + String(seconds).padStart(2, "0");
  }

  function stopTimers() {
    if (expiryIntervalId) {
      window.clearInterval(expiryIntervalId);
      expiryIntervalId = null;
    }
    if (resendIntervalId) {
      window.clearInterval(resendIntervalId);
      resendIntervalId = null;
    }
  }

  function updateResendState() {
    if (!btnResendOtp) return;
    const secondsLeft = Math.ceil((resendAllowedAt - Date.now()) / 1000);
    if (secondsLeft > 0) {
      btnResendOtp.disabled = true;
      return;
    }
    btnResendOtp.disabled = false;
    if (resendIntervalId) {
      window.clearInterval(resendIntervalId);
      resendIntervalId = null;
    }
  }

  function startOtpTimers(expiresIn) {
    if (!otpCountdown) return;

    stopTimers();
    const ttl = Number(expiresIn) > 0 ? Number(expiresIn) : 180;
    const expiryAt = Date.now() + ttl * 1000;

    otpCountdown.hidden = false;
    otpCountdown.textContent = "Code expires in " + formatCountdown(ttl);
    expiryIntervalId = window.setInterval(function () {
      const seconds = Math.ceil((expiryAt - Date.now()) / 1000);
      otpCountdown.textContent = "Code expires in " + formatCountdown(seconds);
      if (seconds <= 0) {
        window.clearInterval(expiryIntervalId);
        expiryIntervalId = null;
      }
    }, 1000);

    resendAllowedAt = Date.now() + 30 * 1000;
    updateResendState();
    resendIntervalId = window.setInterval(updateResendState, 1000);
  }

  function setGlobalLoading(isLoading) {
    activeRequestCount += isLoading ? 1 : -1;
    if (activeRequestCount < 0) activeRequestCount = 0;

    const disable = activeRequestCount > 0;
    document.querySelectorAll("button, input").forEach(function (element) {
      element.disabled = disable;
    });

    if (btnGoogleLogin) {
      btnGoogleLogin.setAttribute("aria-disabled", disable ? "true" : "false");
    }
  }

  function startButtonLoading(button, loadingText) {
    if (!button) return;
    activeLoadingButton = button;
    activeLoadingButtonText = button.textContent;
    button.classList.add("is-loading");
    button.textContent = loadingText;
  }

  function stopButtonLoading() {
    if (!activeLoadingButton) return;
    activeLoadingButton.classList.remove("is-loading");
    activeLoadingButton.textContent = activeLoadingButtonText;
    activeLoadingButton = null;
    activeLoadingButtonText = "";
  }

  async function parseJsonSafe(response) {
    try {
      return await response.json();
    } catch (_error) {
      return {};
    }
  }

  function getErrorMessage(status, body, fallback) {
    if (status >= 500) return "Something went wrong. Please try again.";
    if (status >= 400 && body && typeof body.error === "string") return body.error;
    return fallback;
  }

  async function postJson(path, payload) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await parseJsonSafe(response);
    return { response, data };
  }

  function showOtpStep(emailValue) {
    if (!emailHidden || !emailDisplay || !stepEmail || !stepOtp) return;
    clearError();
    emailHidden.value = emailValue;
    emailDisplay.textContent = emailValue;
    stepEmail.hidden = true;
    stepOtp.hidden = false;
    if (otpInput) {
      otpInput.value = "";
      otpInput.focus();
    }
  }

  function showEmailStep() {
    if (!stepEmail || !stepOtp) return;
    stopTimers();
    stepOtp.hidden = true;
    stepEmail.hidden = false;
    currentEmail = "";
    if (otpCountdown) {
      otpCountdown.textContent = "";
      otpCountdown.hidden = true;
    }
    if (emailHidden) {
      emailHidden.value = "";
    }
    if (otpInput) {
      otpInput.value = "";
    }
    if (emailInput) {
      emailInput.focus();
    }
  }

  function getValidatedEmail() {
    if (!emailInput) return null;
    const value = emailInput.value.trim();
    if (!EMAIL_REGEX.test(value)) {
      showError("Invalid email format");
      emailInput.focus();
      return null;
    }
    return value;
  }

  async function sendOtp() {
    const emailValue = getValidatedEmail();
    if (!emailValue) return;

    clearError();
    startButtonLoading(btnSendCode, "Sending...");
    setGlobalLoading(true);

    try {
      const { response, data } = await postJson("/api/auth/otp/send", {
        email: emailValue,
        tenant_id: TENANT_ID,
      });

      if (!response.ok) {
        showError(getErrorMessage(response.status, data, "Failed to send OTP"));
        return;
      }

      currentEmail = emailValue;
      showOtpStep(emailValue);
      startOtpTimers(data.expires_in);
    } catch (_error) {
      showError("Connection error. Please try again.");
    } finally {
      setGlobalLoading(false);
      stopButtonLoading();
      updateResendState();
    }
  }

  async function verifyOtp(event) {
    if (event) event.preventDefault();
    if (!otpInput) return;

    clearError();
    const otpValue = otpInput.value.trim();
    const emailValue = currentEmail || (emailHidden ? emailHidden.value.trim() : "");

    if (!emailValue) {
      showError("Session expired. Please request a new code.");
      showEmailStep();
      return;
    }

    startButtonLoading(btnVerifyOtp, "Verifying...");
    setGlobalLoading(true);

    try {
      const { response, data } = await postJson("/api/auth/otp/verify", {
        email: emailValue,
        otp: otpValue,
        tenant_id: TENANT_ID,
      });

      if (!response.ok) {
        if (response.status === 401) {
          showError("Incorrect code. Try again.");
          otpInput.value = "";
          otpInput.focus();
          return;
        }

        if (response.status === 400) {
          showError("Session expired. Please request a new code.");
          showEmailStep();
          return;
        }

        showError(getErrorMessage(response.status, data, "Something went wrong. Please try again."));
        return;
      }

      localStorage.setItem("fanos_token", data.access_token || "");
      localStorage.setItem("fanos_refresh_token", data.refresh_token || "");
      localStorage.setItem("fanos_fan_id", data.fan_id || "");
      window.location.href = "/dashboard";
    } catch (_error) {
      showError("Connection error. Please try again.");
    } finally {
      setGlobalLoading(false);
      stopButtonLoading();
      updateResendState();
    }
  }

  async function startGoogleLogin(event) {
    event.preventDefault();
    clearError();
    setGlobalLoading(true);

    if (btnGoogleLogin) {
      activeGoogleText = btnGoogleLogin.textContent;
      btnGoogleLogin.classList.add("is-loading");
      btnGoogleLogin.textContent = "Redirecting...";
    }

    try {
      const response = await fetch(
        "/api/auth/social/url?tenant_id=" + encodeURIComponent(TENANT_ID) + "&provider=google"
      );
      const data = await parseJsonSafe(response);

      if (!response.ok || !data.url) {
        showError("Google login unavailable. Please use email login.");
        return;
      }

      window.location.href = data.url;
    } catch (_error) {
      showError("Google login unavailable. Please use email login.");
    } finally {
      setGlobalLoading(false);
      if (btnGoogleLogin) {
        btnGoogleLogin.classList.remove("is-loading");
        btnGoogleLogin.textContent = activeGoogleText;
      }
      updateResendState();
    }
  }

  if (tabEmail && tabSocial) {
    tabEmail.addEventListener("click", function () {
      setTab("email");
    });
    tabSocial.addEventListener("click", function () {
      setTab("social");
    });
  }

  if (btnSendCode) {
    btnSendCode.addEventListener("click", sendOtp);
  }

  if (btnChangeEmail) {
    btnChangeEmail.addEventListener("click", function () {
      clearError();
      showEmailStep();
    });
  }

  if (btnResendOtp) {
    btnResendOtp.addEventListener("click", function () {
      if (Date.now() < resendAllowedAt) return;
      sendOtp();
    });
  }

  if (otpForm) {
    otpForm.addEventListener("submit", verifyOtp);
  }

  if (btnGoogleLogin) {
    btnGoogleLogin.addEventListener("click", startGoogleLogin);
  }

  if (emailInput) {
    emailInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        sendOtp();
      }
    });
  }
})();
