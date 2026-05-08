(function () {
  const fanIdEl = document.getElementById("fan-id");
  const emailEl = document.getElementById("fan-email");
  const tenantIdEl = document.getElementById("tenant-id");
  const logoutButton = document.getElementById("btn-logout");
  const errorEl = document.getElementById("dashboard-error");

  function showError(message) {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function clearFanosStorage() {
    Object.keys(localStorage).forEach(function (key) {
      if (key.startsWith("fanos_")) {
        localStorage.removeItem(key);
      }
    });
  }

  function decodeToken(token) {
    return JSON.parse(window.atob(token.split(".")[1]));
  }

  function redirectToLogin() {
    window.location.href = "/login";
  }

  function applySocialTokenFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("token");
    if (!urlToken) return;

    localStorage.setItem("fanos_token", urlToken);
    localStorage.setItem("fanos_fan_id", params.get("fan_id") || "");
    window.history.replaceState({}, "", "/dashboard");
  }

  async function refreshTokenIfNeeded() {
    const token = localStorage.getItem("fanos_token");
    const refreshToken = localStorage.getItem("fanos_refresh_token");
    if (!token || !refreshToken) return;

    let payload;
    try {
      payload = decodeToken(token);
    } catch (_error) {
      return;
    }

    if (!payload.exp) return;
    const secondsRemaining = payload.exp - Math.floor(Date.now() / 1000);
    if (secondsRemaining > 60) {
      window.setTimeout(refreshTokenIfNeeded, (secondsRemaining - 60) * 1000);
      return;
    }

    try {
      const response = await fetch("/api/auth/token/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      const data = await response.json().catch(function () {
        return {};
      });

      if (response.status === 401) {
        clearFanosStorage();
        redirectToLogin();
        return;
      }

      if (response.ok && data.access_token) {
        localStorage.setItem("fanos_token", data.access_token);
        refreshTokenIfNeeded();
      }
    } catch (_error) {
      // Ignore background refresh network issues and keep current session.
    }
  }

  function renderFanInfo() {
    const token = localStorage.getItem("fanos_token");
    if (!token) {
      redirectToLogin();
      return;
    }

    try {
      const payload = decodeToken(token);
      if (fanIdEl) fanIdEl.textContent = payload.fan_id || localStorage.getItem("fanos_fan_id") || "-";
      if (emailEl) emailEl.textContent = payload.email || "-";
      if (tenantIdEl) tenantIdEl.textContent = payload.tenant_id || "-";
    } catch (_error) {
      showError("Something went wrong. Please try again.");
    }
  }

  async function logout() {
    const refreshToken = localStorage.getItem("fanos_refresh_token");

    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken || "" }),
      });
    } catch (_error) {
      // Spec requires same client behavior regardless of server response.
    } finally {
      localStorage.removeItem("fanos_token");
      localStorage.removeItem("fanos_refresh_token");
      localStorage.removeItem("fanos_fan_id");
      window.location.href = "/";
    }
  }

  applySocialTokenFromUrl();

  if (!localStorage.getItem("fanos_token")) {
    redirectToLogin();
  } else {
    renderFanInfo();
    refreshTokenIfNeeded();
  }

  if (logoutButton) {
    logoutButton.addEventListener("click", logout);
  }
})();
