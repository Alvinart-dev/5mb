const express = require("express");
const cors = require("cors");
const path = require("path");
const https = require("https");
const http = require("http");
const axios = require("axios");
const FormData = require("form-data");

const app = express();
const PORT = process.env.PORT || 7860;
const BASE = "https://amfinder.web.id";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

app.use(cors({ origin: "*" }));
app.use(express.json());

function httpGet(url, options, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 10) return reject(new Error("Too many redirects"));
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const loc = res.headers.location;
        if (!loc) return reject(new Error("Redirect tanpa Location"));
        res.resume();
        const next = loc.startsWith("http") ? loc : new URL(loc, url).href;
        return resolve(httpGet(next, options, redirectCount + 1));
      }
      resolve(res);
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

async function uploadToUguu(buffer, filename) {
  const form = new FormData();
  form.append("files[]", buffer, { filename });
  const res = await axios.post("https://uguu.se/upload.php", form, {
    headers: { ...form.getHeaders(), "User-Agent": UA },
    timeout: 60000,
    maxBodyLength: Infinity,
    proxy: false,
  });
  const url = res.data?.files?.[0]?.url;
  if (!url) throw new Error("Uguu upload gagal");
  return url;
}

function scrapePreset(tiktokUrl) {
  return new Promise((resolve, reject) => {
    const endpoint = `${BASE}/api/find?url=${encodeURIComponent(tiktokUrl)}`;
    const options = {
      headers: {
        "User-Agent": UA,
        Accept: "text/event-stream",
        Referer: `${BASE}/`,
        Origin: BASE,
        "Cache-Control": "no-cache",
      },
    };

    let resolved = false;

    (async () => {
      try {
        const res = await httpGet(endpoint, options);
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        let buffer = "";
        let lastEvent = "";

        res.on("data", (chunk) => {
          if (resolved) return;
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop();

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              lastEvent = line.slice(7).trim();
              continue;
            }
            if (line.startsWith("data: ") && lastEvent === "result") {
              const raw = line.slice(6).trim();
              try {
                const json = JSON.parse(raw);
                resolved = true;
                res.destroy();
                resolve(json);
              } catch {
                reject(new Error("Parse error: " + raw));
              }
            }
          }
        });

        res.on("end", () => {
          if (!resolved) reject(new Error("Stream ended without result"));
        });
        res.on("error", (e) => {
          if (!resolved) reject(e);
        });
      } catch (err) {
        reject(err);
      }
    })();
  });
}

app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get("/api/search", async (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({ ok: false, error: "Parameter url wajib diisi" });
  }

  if (!/tiktok\.com|vt\.tiktok|vm\.tiktok/i.test(url)) {
    return res.status(400).json({ ok: false, error: "URL harus dari TikTok" });
  }

  try {
    const data = await scrapePreset(url);

    let videoNoWm = null;
    if (data?.video?.playUrlNoWm) {
      try {
        const buf = await axios
          .get(data.video.playUrlNoWm, {
            responseType: "arraybuffer",
            timeout: 60000,
            headers: { "User-Agent": UA },
          })
          .then((r) => Buffer.from(r.data));
        videoNoWm = await uploadToUguu(
          buf,
          `tiktok_${data.video.id || Date.now()}.mp4`
        );
      } catch (e) {
        console.error("[upload]", e.message);
      }
    }

    res.json({
      ok: true,
      found: data.found ?? (data.presetLinks?.length > 0),
      video: videoNoWm,
      presets: data.presetLinks ?? [],
      author: data.author,
      description: data.video?.description?.trim(),
      stats: data.video?.stats,
      cover: data.video?.cover,
      authorDetail: data.authorDetail,
    });
  } catch (err) {
    console.error("[search]", err.message);
    res.status(500).json({
      ok: false,
      error: "Gagal mengambil data. Coba lagi nanti.",
    });
  }
});

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "index.html"));
});

app.use((err, req, res, next) => {
  console.error("[server]", err);
  res.status(500).json({ ok: false, error: "Internal server error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[5mb Search] http://0.0.0.0:${PORT}`);
});