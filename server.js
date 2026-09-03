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

app.get("/api/update", async (_req, res, next) => {
  try { res.set("cache-control", "no-store").json({ status: await status() }); } catch (error) { next(error); }
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
    const match = source.match(/(?:const|let)\s+APP_DATA\s*=\s*(\{[\s\S]*?\});\s*\n/);
    if (!match) throw new Error("원본 데이터 형식을 찾지 못했습니다.");
    res.set("cache-control", "no-store").json({ appData: JSON.parse(match[1]) });
  } catch (error) { next(error); }
});

app.get("*splat", (_req, res) => res.sendFile(path.join(root, "firebase-public", "index.html")));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error instanceof Error ? error.message : "서버 오류" });
});

app.listen(process.env.PORT || 8080, "0.0.0.0");
