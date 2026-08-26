// deploy-refresh: 2026-08-04
(() => {
  const REVIEW_KEY = "thelaundry-review-overrides-v1";
  const SYNC_MARKER = "thelaundry-cloud-sync-v1";
  const UPDATE_POLL_MS = 15000;
  const UPDATE_POLL_FAST_MS = 5000;
  const APP_DATA_POLL_MS = 60000;
  const DEFAULT_UPDATE_BUTTON_TEXT = "데이터 업데이트";
  const REQUEST_STALE_MS = 15 * 60 * 1000;

  let updateButton = null;
  let updatePollTimer = null;
  let appDataPollTimer = null;
  let lastStatusKey = "";
  let handledCompletionKey = "";
  let lastAppDataKey = "";
  let statusInFlight = false;
  let syncInFlight = false;

  function notice(message, kind = "info") {
    let el = document.getElementById("cloudNotice");
    if (!el) {
      el = document.createElement("div");
      el.id = "cloudNotice";
      el.style.cssText =
        "position:fixed;right:18px;bottom:18px;z-index:9999;max-width:380px;" +
        "padding:12px 15px;border-radius:12px;color:#fff;font:700 13px/1.45 system-ui;" +
        "box-shadow:0 8px 28px rgba(17,47,70,.24)";
      document.body.appendChild(el);
    }
    el.style.background = kind === "error" ? "#c94b4b" : "#173f5f";
    el.textContent = message;
    window.clearTimeout(notice.timer);
    notice.timer = window.setTimeout(() => el.remove(), 5000);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  }

  function readAppData() {
    try {
      return window.eval("APP_DATA");
    } catch {
      return null;
    }
  }

  function latestRecordMonth(data) {
    const months = (data?.records || [])
      .map((record) => String(record.month || ""))
      .filter(Boolean)
      .sort();
    return months[months.length - 1] || "";
  }

  function appDataKey(data) {
    if (!data) return "";
    return [
      data.updatedAt || "",
      data.completedThrough || "",
      latestRecordMonth(data),
      Array.isArray(data.records) ? data.records.length : 0,
    ].join("|");
  }

  function statusKey(status) {
    if (!status) return "";
    return [status.state || "", status.month || "", status.requestedAt || "", status.completedAt || ""].join("|");
  }

  function completionKey(status) {
    if (!status || !["completed", "failed"].includes(status.state)) return "";
    return [status.month || "", status.requestedAt || "", status.completedAt || "", status.state || ""].join("|");
  }

  function localReviews() {
    try {
      return JSON.parse(localStorage.getItem(REVIEW_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function parseStatusTimestamp(value) {
    if (!value || typeof value !== "string") return null;
    const native = Date.parse(value);
    if (!Number.isNaN(native)) return native;
    const match = value.match(
      /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*KST$/,
    );
    if (!match) return null;
    const [, year, month, day, hour, minute, second = "00"] = match;
    return Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour) - 9,
      Number(minute),
      Number(second),
    );
  }

  function isRequestedStale(status) {
    if (!status || status.state !== "requested") return false;
    if (status.stale) return true;
    const requestedAt = parseStatusTimestamp(status.requestedAt);
    if (!requestedAt) return false;
    return Date.now() - requestedAt > REQUEST_STALE_MS;
  }

  function setUpdateButtonState(status) {
    if (!updateButton) return;
    const requested = status?.state === "requested";
    const running = status?.state === "running";
    const staleRequest = isRequestedStale(status);
    updateButton.disabled = running;
    updateButton.textContent = running
      ? "업데이트 진행 중..."
      : requested && !staleRequest
        ? "업데이트 요청 접수됨"
        : DEFAULT_UPDATE_BUTTON_TEXT;
    updateButton.title = running
      ? `${status?.month || "이번 달"} 데이터 업데이트가 진행 중입니다.`
      : requested && !staleRequest
        ? `${status?.month || "이번 달"} 데이터 업데이트 요청이 접수되었습니다. 자동 반영까지 최대 5분 정도 걸릴 수 있습니다.`
        : "오늘 기준 최신 자료까지 갱신 요청합니다. 매월 1일 자동 갱신도 함께 동작합니다.";
  }

  function syncPeriodToLatestMonth(beforeData, afterData) {
    const start = document.getElementById("periodStart");
    const end = document.getElementById("periodEnd");
    if (!start || !end) return;

    const beforeLatest = latestRecordMonth(beforeData) || beforeData?.completedThrough || "";
    const afterLatest = latestRecordMonth(afterData) || afterData?.completedThrough || "";
    if (!afterLatest) return;

    const currentEnd = end.value || beforeData?.completedThrough || beforeLatest || "";
    const shouldMoveEnd =
      !end.value ||
      currentEnd === beforeData?.completedThrough ||
      currentEnd === beforeLatest;

    if (shouldMoveEnd && currentEnd < afterLatest) {
      end.value = afterLatest;
      if (!start.value || start.value > end.value) {
        start.value = end.value;
      }
    }
  }

  async function syncDashboardData({ noticeMessage = "" } = {}) {
    if (syncInFlight || typeof window.loadLatestAppData !== "function") return false;
    syncInFlight = true;
    try {
      const beforeData = readAppData();
      const beforeKey = appDataKey(beforeData);
      const loaded = await window.loadLatestAppData();
      if (!loaded) return false;

      const afterData = readAppData();
      const afterKey = appDataKey(afterData);
      lastAppDataKey = afterKey;

      syncPeriodToLatestMonth(beforeData, afterData);
      if (typeof window.renderHeaderMeta === "function") window.renderHeaderMeta();
      if (typeof window.refresh === "function") window.refresh(false);

      if (noticeMessage && beforeKey !== afterKey) {
        notice(noticeMessage);
      }
      return beforeKey !== afterKey;
    } catch (error) {
      console.warn("대시보드 자동 갱신 실패", error);
      return false;
    } finally {
      syncInFlight = false;
    }
  }

  async function loadSharedReviews() {
    try {
      const payload = await api("/api/reviews");
      const shared = payload.reviews || {};
      const local = localReviews();
      const merged = { ...shared, ...local };
      const mergedText = JSON.stringify(merged);
      if (mergedText !== JSON.stringify(local) && sessionStorage.getItem(SYNC_MARKER) !== mergedText) {
        localStorage.setItem(REVIEW_KEY, mergedText);
        sessionStorage.setItem(SYNC_MARKER, mergedText);
        location.reload();
        return;
      }
      sessionStorage.removeItem(SYNC_MARKER);
    } catch (error) {
      console.warn("공용 검토결과 불러오기 실패", error);
    }
  }

  async function saveSharedReviews() {
    try {
      await api("/api/reviews", {
        method: "PUT",
        body: JSON.stringify({ reviews: localReviews() }),
      });
      notice("검토결과가 공용 데이터로 저장되었습니다.");
    } catch (error) {
      console.warn("공용 검토결과 저장 실패", error);
      notice("공용 저장에 실패했습니다. 잠시 후 다시 시도해 주세요.", "error");
    }
  }

  async function requestMonthlyUpdate(button) {
    button.disabled = true;
    button.textContent = "업데이트 요청 중...";
    try {
      const payload = await api("/api/update", { method: "POST", body: "{}" });
      const status = payload.status || {};
      notice(`${status.month || "이번 달"} 데이터 업데이트 요청이 접수되었습니다. 자동 반영까지 최대 5분 정도 걸릴 수 있습니다.`);
      setUpdateButtonState(status);
      startUpdatePolling(true);
    } catch (error) {
      const message = String(error).includes("429")
        ? "이미 업데이트 요청이 접수되어 있습니다. 잠시 후 다시 확인해 주세요."
        : "업데이트 요청에 실패했습니다. 잠시 후 다시 시도해 주세요.";
      notice(message, "error");
      button.disabled = false;
      button.textContent = DEFAULT_UPDATE_BUTTON_TEXT;
    }
  }

  function addCloudControls() {
    const csv = document.getElementById("csvBtn");
    if (!csv || document.getElementById("monthlyUpdateBtn")) return;

    const update = document.createElement("button");
    update.id = "monthlyUpdateBtn";
    update.className = "btn";
    update.type = "button";
    update.textContent = DEFAULT_UPDATE_BUTTON_TEXT;
    update.title = "오늘 기준 최신 자료까지 갱신 요청합니다. 매월 1일 자동 갱신도 함께 동작합니다.";
    update.addEventListener("click", () => requestMonthlyUpdate(update));
    csv.parentElement.insertBefore(update, csv);
    updateButton = update;
  }

  async function pollUpdateStatus() {
    if (statusInFlight) return;
    statusInFlight = true;
    try {
      const payload = await api("/api/update");
      const status = payload?.status || {};
      const currentStatusKey = statusKey(status);
      const currentCompletionKey = completionKey(status);

      setUpdateButtonState(status);

      if (
        currentCompletionKey &&
        currentCompletionKey !== handledCompletionKey &&
        currentStatusKey !== lastStatusKey
      ) {
        handledCompletionKey = currentCompletionKey;
        const changed = await syncDashboardData({
          noticeMessage:
            status.state === "completed"
              ? `${status.month || "이번 달"} 데이터가 자동 반영되었습니다.`
              : "데이터 업데이트가 실패했습니다. 잠시 후 다시 시도해 주세요.",
        });
        if (!changed && status.state === "completed") {
          notice(`${status.month || "이번 달"} 데이터 업데이트가 완료되었습니다.`);
        }
      }

      lastStatusKey = currentStatusKey;
    } catch (error) {
      console.warn("업데이트 상태 확인 실패", error);
    } finally {
      statusInFlight = false;
    }
  }

  async function pollAppData() {
    try {
      const payload = await api("/api/app-data");
      const nextKey = appDataKey(payload?.data);
      if (!nextKey) return;
      if (!lastAppDataKey) {
        lastAppDataKey = appDataKey(readAppData()) || nextKey;
        return;
      }
      if (nextKey !== lastAppDataKey) {
        await syncDashboardData({ noticeMessage: "공용 데이터가 최신 상태로 반영되었습니다." });
      }
    } catch (error) {
      console.warn("공용 데이터 변경 확인 실패", error);
    }
  }

  function startUpdatePolling(fast = false) {
    if (updatePollTimer) window.clearInterval(updatePollTimer);
    updatePollTimer = window.setInterval(pollUpdateStatus, fast ? UPDATE_POLL_FAST_MS : UPDATE_POLL_MS);
    pollUpdateStatus();
  }

  function startAppDataPolling() {
    if (appDataPollTimer) window.clearInterval(appDataPollTimer);
    appDataPollTimer = window.setInterval(pollAppData, APP_DATA_POLL_MS);
    pollAppData();
  }

  document.addEventListener(
    "click",
    (event) => {
      if (event.target && ["saveReview", "resetReview"].includes(event.target.id)) {
        window.setTimeout(saveSharedReviews, 80);
      }
    },
    true,
  );

  addCloudControls();
  lastAppDataKey = appDataKey(readAppData());
  loadSharedReviews();
  startUpdatePolling();
  startAppDataPolling();
})();
