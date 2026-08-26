import { mkdir, cp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
const publicDir = path.join(dist, "public");
const serverDir = path.join(dist, "server");
const hostingDir = path.join(dist, ".openai");

if (existsSync(dist)) {
  await rm(dist, { recursive: true, force: true });
}

await mkdir(publicDir, { recursive: true });
await mkdir(serverDir, { recursive: true });
await mkdir(hostingDir, { recursive: true });

const indexHtml = await readFile(path.join(root, "index.html"), "utf-8");
const historyHtml = await readFile(path.join(root, "history.html"), "utf-8");
const cloudJs = await readFile(path.join(root, "cloud.js"), "utf-8");

await cp(path.join(root, "index.html"), path.join(publicDir, "index.html"));
await cp(path.join(root, "history.html"), path.join(publicDir, "history.html"));
await cp(path.join(root, "cloud.js"), path.join(publicDir, "cloud.js"));
await cp(path.join(root, ".openai", "hosting.json"), path.join(hostingDir, "hosting.json"));

const serverCode = `const files = {
  "/": ${JSON.stringify(indexHtml)},
  "/index.html": ${JSON.stringify(indexHtml)},
  "/history.html": ${JSON.stringify(historyHtml)},
  "/cloud.js": ${JSON.stringify(cloudJs)}
};

const backendOrigin = "https://thelaundry-market-dashboard.thelaundry-market-2026.workers.dev";
// 월별 자동 수집 작업은 저장소의 기본 브랜치(master)에 결과를 반영한다.
// 대시보드도 같은 원본을 읽어야 모든 사용자가 동일한 최신 데이터를 본다.
const repoAppDataUrl = "https://raw.githubusercontent.com/haechulcosmo/laundromat-count/master/index.html";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

function safePathname(url) {
  try {
    const pathname = new URL(String(url || "/"), "https://example.com").pathname;
    if (pathname === "/" || pathname === "") return "/index.html";
    return pathname;
  } catch {
    return "/index.html";
  }
}

export default {
  async fetch(request) {
    const pathname = safePathname(request.url);

    if (pathname === "/api/app-data") {
      const extractAppData = (html) => {
        const match = html.match(/(?:const|let)\\s+APP_DATA\\s*=\\s*(\\{[\\s\\S]*?\\});\\s*\\n/);
        if (!match) return null;
        try {
          return JSON.parse(match[1]);
        } catch {
          return null;
        }
      };

      try {
        const sourceResponse = await fetch(repoAppDataUrl, {
          headers: { "cache-control": "no-cache" }
        });
        if (sourceResponse.ok) {
          const html = await sourceResponse.text();
          const data = extractAppData(html);
          if (data) {
            return new Response(JSON.stringify({ data }), {
              headers: {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
                "access-control-allow-origin": "*"
              }
            });
          }
        }
      } catch {}
    }

    if (pathname.startsWith("/api/")) {
      const targetUrl = backendOrigin + pathname + new URL(String(request.url || "https://example.com"), "https://example.com").search;
      const method = request.method || "GET";
      const headers = new Headers(request.headers);
      headers.set("accept", "application/json");
      if (pathname === "/api/update" && method === "POST") {
        headers.set("origin", backendOrigin);
      }
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
            "access-control-allow-headers": "content-type"
          }
        });
      }
      const backendResponse = await fetch(targetUrl, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : await request.text()
      });
      return new Response(backendResponse.body, {
        status: backendResponse.status,
        headers: {
          "content-type": backendResponse.headers.get("content-type") || "application/json; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
          "access-control-allow-headers": "content-type"
        }
      });
    }

    const body = files[pathname];
    if (body != null) {
      const ext = pathname.endsWith(".js") ? ".js" : ".html";
      return new Response(body, {
        headers: {
          "content-type": contentTypes[ext] || "application/octet-stream",
          "cache-control": "no-cache"
        }
      });
    }
    return new Response(files["/index.html"], {
      status: pathname.endsWith(".html") ? 200 : 404,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache"
      }
    });
  }
};
`;

await writeFile(path.join(serverDir, "index.js"), serverCode, "utf-8");
