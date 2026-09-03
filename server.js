import express from "express";
import admin from "firebase-admin";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(root, "firebase-public"), { index: "index.html", etag: false, maxAge: 0 }));

admin.initializeApp();
const db = admin.firestore();
const repoDataUrl = "https://raw.githubusercontent.com/haechulcosmo/laundromat-count/master/index.html";

function currentMonth() {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit" }).formatToParts(new Date()).filter((item) => item.type !== "literal").map((item) => [item.type, item.value]));
  return `${values.year}-${values.month}`;
}

async function status() {
  const snap = await db.doc("dashboard/updateStatus").get();
  return snap.exists ? snap.data() : null;
}

function extractAppData(source) {
  const marker = /(?:const|let)\s+APP_DATA\s*=\s*/.exec(source);
  if (!marker) throw new Error("원본 데이터 형식을 찾지 못했습니다.");
  const start = marker.index + marker[0].length;
  let depth = 0;
  let quoted = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\\\") escaped = true;
      else if (char === quoted) quoted = null;
      continue;
    }
    if (char === '"' || char === "'") { quoted = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(source.slice(start, index + 1));
    }
  }
  throw new Error("원본 데이터 끝을 찾지 못했습니다.");
}

app.get("/api/update", async (_req, res, next) => {
  try { res.set("cache-control", "no-store").json({ status: await status() }); } catch (error) { next(error); }
});

app.get("/api/source/dbland", async (req, res, next) => {
  try {
    const page = Math.max(1, Math.min(1000, Number(req.query.page || 1)));
    const body = new URLSearchParams({ type: "place", sch_ca_id: "021302", itemsPerPage: "50", currentPage: String(page) });
    const response = await fetch("https://db-land.kr/archive/proc/get_list.php", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        referer: "https://db-land.kr/archive/place/021302/1",
        "user-agent": "Mozilla/5.0",
      },
      body,
    });
    if (!response.ok) throw new Error(`DB랜드 응답 오류 (${response.status})`);
    res.set("cache-control", "no-store").json(await response.json());
  } catch (error) { next(error); }
});

app.post("/api/update", async (_req, res, next) => {
  try {
    const month = currentMonth();
    const current = await status();
    if (current?.month === month && ["requested", "running"].includes(current.state)) return res.status(429).json({ error: "이미 업데이트가 진행 중입니다.", status: current });
    const requested = { state: "requested", month, requestedAt: new Date().toISOString(), requestedBy: "dashboard" };
    await db.doc("dashboard/updateStatus").set(requested);
    res.status(202).json({ ok: true, status: requested });
  } catch (error) { next(error); }
});

app.post("/api/update/complete", async (req, res, next) => {
  try {
    if (!process.env.UPDATE_CALLBACK_TOKEN || req.get("x-update-callback") !== process.env.UPDATE_CALLBACK_TOKEN) {
      return res.status(403).json({ error: "권한이 없습니다." });
    }
    const current = await status();
    const requested = req.body && typeof req.body === "object" ? req.body : {};
    const state = ["running", "completed", "failed"].includes(requested.state) ? requested.state : "completed";
    const completed = { ...(current || {}), ...requested, state, month: requested.month || current?.month || "" };
    if (state !== "running") completed.completedAt = new Date().toISOString();
    await db.doc("dashboard/updateStatus").set(completed);
    res.json({ ok: true, status: completed });
  } catch (error) { next(error); }
});

app.get("/api/app-data", async (_req, res, next) => {
  try {
    const response = await fetch(repoDataUrl, { headers: { "user-agent": "thelaundry-market-dashboard" } });
    const source = await response.text();
    res.set("cache-control", "no-store").json({ data: extractAppData(source) });
  } catch (error) { next(error); }
});

app.get("*splat", (_req, res) => res.sendFile(path.join(root, "firebase-public", "index.html")));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error instanceof Error ? error.message : "서버 오류" });
});

app.listen(process.env.PORT || 8080, "0.0.0.0");
