import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import admin from "firebase-admin";

admin.initializeApp();
const db = admin.firestore();
const updateCallbackToken = defineSecret("UPDATE_CALLBACK_TOKEN");
const GITHUB_DATA_URL = "https://raw.githubusercontent.com/haechulcosmo/laundromat-count/master/index.html";
const DBLAND_URL = "https://db-land.kr/archive/place/021302/";
const QDB_URL = "https://qdb.kr/db/place.php?cate_3=%EC%85%80%ED%94%84%EB%B9%A8%EB%9E%98%EB%B0%A9&cate_3c=1065";
const STALE_MS = 2 * 60 * 60 * 1000;

function nowKstMonth() {
  const pieces = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const value = Object.fromEntries(pieces.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}`;
}

function stale(status) {
  if (!status || !["requested", "running"].includes(status.state)) return false;
  const value = Date.parse(status.startedAt || status.requestedAt || "");
  return !Number.isFinite(value) || Date.now() - value > STALE_MS;
}

function statusSummary(status) {
  return status ? { ...status, stale: stale(status) } : null;
}

async function documentData(path) {
  const snapshot = await db.doc(path).get();
  return snapshot.exists ? snapshot.data() : null;
}

async function parseBody(req) {
  if (!req.body || typeof req.body !== "object") throw new Error("JSON 형식이 올바르지 않습니다.");
  return req.body;
}

async function appData() {
  const source = await fetch(GITHUB_DATA_URL, { headers: { "user-agent": "thelaundry-market-dashboard" } });
  if (!source.ok) throw new Error(`원본 데이터를 불러오지 못했습니다 (${source.status}).`);
  const html = await source.text();
  const match = html.match(/(?:const|let)\s+APP_DATA\s*=\s*(\{[\s\S]*?\});\s*\n/);
  if (!match) throw new Error("원본 데이터 형식을 확인할 수 없습니다.");
  return JSON.parse(match[1]);
}

async function proxy(res, url, page) {
  const target = page ? `${url}${page}` : url;
  const response = await fetch(target, { headers: { "user-agent": "Mozilla/5.0" } });
  res.status(response.status);
  res.set("content-type", response.headers.get("content-type") || "text/html; charset=utf-8");
  res.set("cache-control", "no-store");
  res.send(await response.text());
}

export const api = onRequest(
  { region: "asia-northeast3", secrets: [updateCallbackToken], cors: false, timeoutSeconds: 60 },
  async (req, res) => {
    try {
      const path = req.path.replace(/^\/api(?=\/|$)/, "").replace(/\/$/, "") || "/";
      if (path === "/reviews") {
        if (req.method === "GET") return res.set("cache-control", "no-store").json({ reviews: (await documentData("dashboard/reviews"))?.items || {} });
        if (req.method !== "PUT") return res.status(405).send("Method not allowed");
        const payload = await parseBody(req);
        const reviews = payload.reviews;
        if (!reviews || Array.isArray(reviews) || typeof reviews !== "object") return res.status(400).json({ error: "reviews 객체가 필요합니다." });
        const encoded = JSON.stringify(reviews);
        if (Object.keys(reviews).length > 5000 || encoded.length > 900000) return res.status(413).json({ error: "저장 가능한 검토 데이터 크기를 초과했습니다." });
        await db.doc("dashboard/reviews").set({ items: reviews, updatedAt: new Date().toISOString() });
        return res.json({ ok: true, saved: Object.keys(reviews).length });
      }

      if (path === "/update") {
        const current = await documentData("dashboard/updateStatus");
        if (req.method === "GET") return res.set("cache-control", "no-store").json({ status: statusSummary(current) });
        if (req.method !== "POST") return res.status(405).send("Method not allowed");
        const month = nowKstMonth();
        if (current?.month === month && ["requested", "running"].includes(current.state) && !stale(current)) {
          return res.status(429).json({ error: "이미 같은 달 데이터 업데이트가 진행 중입니다. 잠시 후 다시 확인해 주세요.", status: statusSummary(current) });
        }
        const status = { state: "requested", month, requestedAt: new Date().toISOString(), requestedBy: "dashboard" };
        await db.doc("dashboard/updateStatus").set(status);
        return res.status(202).json({ ok: true, status: statusSummary(status) });
      }

      if (path === "/update/complete" && req.method === "POST") {
        if (req.get("x-update-callback") !== updateCallbackToken.value()) return res.status(403).json({ error: "권한이 없습니다." });
        const payload = await parseBody(req);
        const current = await documentData("dashboard/updateStatus");
        const state = ["completed", "failed", "running"].includes(payload.state) ? payload.state : "completed";
        const status = { ...(current || {}), ...payload, state, month: payload.month || current?.month || "", completedAt: state === "running" ? current?.completedAt || "" : new Date().toISOString() };
        await db.doc("dashboard/updateStatus").set(status);
        return res.json({ ok: true, status: statusSummary(status) });
      }

      if (path === "/app-data" && req.method === "GET") return res.set("cache-control", "no-store").json({ appData: await appData() });
      if (path === "/source/dbland" && req.method === "GET") return proxy(res, DBLAND_URL, Math.max(1, Math.min(1000, Number(req.query.page || 1))));
      if (path === "/source/qdb" && req.method === "GET") return proxy(res, QDB_URL);
      return res.status(404).send("Not found");
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error instanceof Error ? error.message : "서버 오류" });
    }
  },
);
