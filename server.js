// Ashgrove Electricity Hub server
// Serves the dashboard and proxies live data from the SolaX Developer OpenAPI
// (Client ID / Client Secret, services API_Telemetry_V2 + API_Info_V2).
//
// Environment variables (set in Render → Environment, never commit them):
//   SOLAX_CLIENT_ID      required for live data
//   SOLAX_CLIENT_SECRET  required for live data
//   SOLAX_BASE_URL       optional, default https://openapi-eu.solaxcloud.com
//   SOLAX_INVERT_GRID    optional "1" if import/export show the wrong way round
//   SOLAX_INVERT_BATTERY optional "1" if charge/discharge show the wrong way round
//   ACCESS_PASSWORD      optional; if set, the whole site asks for this password
//   PORT                 set by Render

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const BASE = (process.env.SOLAX_BASE_URL || "https://openapi-eu.solaxcloud.com").replace(/\/$/, "");
const CLIENT_ID = process.env.SOLAX_CLIENT_ID || "";
const CLIENT_SECRET = process.env.SOLAX_CLIENT_SECRET || "";
const PASSWORD = process.env.ACCESS_PASSWORD || "";
const GRID_SIGN = process.env.SOLAX_INVERT_GRID === "1" ? -1 : 1;
const BATT_SIGN = process.env.SOLAX_INVERT_BATTERY === "1" ? -1 : 1;
const CACHE_MS = 2 * 60 * 1000; // SolaX cloud only refreshes ~every 5 min
const BUSINESS_TYPE = 1; // residential

// ---------- SolaX client ----------
let token = null, tokenExpires = 0;
let inventory = null, inventoryAt = 0;
let cache = null, cacheAt = 0, inflight = null;

class SolaxError extends Error {}

async function getToken(force = false) {
  if (!force && token && Date.now() < tokenExpires) return token;
  const body = new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "client_credentials" });
  const r = await fetch(`${BASE}/openapi/auth/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 0 || !j.result || !j.result.access_token) {
    throw new SolaxError(`SolaX login failed (code ${j.code ?? r.status}: ${j.message || "no message"}) — check Client ID/Secret`);
  }
  token = j.result.access_token;
  const life = Number(j.result.expires_in) || 3600;
  tokenExpires = Date.now() + Math.max(60, life - 3600) * 1000; // refresh an hour early
  return token;
}

const AUTH_CODES = new Set([10400, 10401, 10402]);

async function api(pathname, params = {}, retry = true) {
  const t = await getToken();
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  const r = await fetch(`${BASE}${pathname}?${qs}`, {
    headers: { Authorization: `bearer ${t}`, "Content-Type": "application/json" },
  });
  const j = await r.json().catch(() => ({}));
  if (AUTH_CODES.has(j.code) && retry) { await getToken(true); return api(pathname, params, false); }
  if (j.code !== 10000) throw new SolaxError(`SolaX ${pathname} failed (code ${j.code ?? r.status}: ${j.message || "no message"})`);
  return j.result;
}

async function pageAll(pathname, params) {
  const out = [];
  for (let pageNo = 1; pageNo <= 10; pageNo++) {
    const res = await api(pathname, { ...params, businessType: BUSINESS_TYPE, pageNo });
    out.push(...((res && res.records) || []));
    if (!res || !res.pages || pageNo >= res.pages) break;
  }
  return out;
}

async function getInventory() {
  if (inventory && Date.now() - inventoryAt < 6 * 3600e3) return inventory;
  const plants = await pageAll("/openapi/v2/plant/page_plant_info", {});
  if (!plants.length) throw new SolaxError("No plants found on this SolaX account");
  const plant = plants[0];
  const inverters = await pageAll("/openapi/v2/device/page_device_info", { plantId: plant.plantId, deviceType: 1 });
  const batteries = await pageAll("/openapi/v2/device/page_device_info", { plantId: plant.plantId, deviceType: 2 }).catch(() => []);
  const meters = await pageAll("/openapi/v2/device/page_device_info", { plantId: plant.plantId, deviceType: 3 }).catch(() => []);
  inventory = { plant, inverters, batteries, meters };
  inventoryAt = Date.now();
  return inventory;
}

const num = v => (v === undefined || v === null || v === "" || isNaN(Number(v)) ? null : Number(v));
const sum = arr => { const v = arr.filter(x => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };

function pvPower(inv) {
  const direct = num(inv.MPPTTotalInputPower);
  if (direct !== null) return direct;
  const m = inv.mpptMap || inv.pvMap || {};
  return sum(Object.entries(m).filter(([k]) => /power/i.test(k)).map(([, v]) => num(v)));
}

async function fetchLive({ raw = false } = {}) {
  const inv = await getInventory();
  const invSns = inv.inverters.map(d => d.deviceSn).filter(Boolean).slice(0, 10);
  if (!invSns.length) throw new SolaxError("No inverter found on this SolaX plant");

  const [invRt, battRt, plantRt] = await Promise.all([
    api("/openapi/v2/device/realtime_data", { snList: invSns.join(","), deviceType: 1, businessType: BUSINESS_TYPE }),
    (async () => {
      const battSns = inv.batteries.map(d => d.deviceSn).filter(Boolean);
      if (battSns.length) return api("/openapi/v2/device/realtime_data", { snList: battSns.slice(0, 10).join(","), deviceType: 2, businessType: BUSINESS_TYPE });
      // Batteries without their own serial are addressed via the inverter SN
      return api("/openapi/v2/device/realtime_data", { snList: invSns.join(","), deviceType: 2, businessType: BUSINESS_TYPE, requestSnType: 1 });
    })().catch(e => ({ error: e.message })),
    api("/openapi/v2/plant/realtime_data", { plantId: inv.plant.plantId, businessType: BUSINESS_TYPE }).catch(e => ({ error: e.message })),
  ]);

  if (raw) return { inventory: inv, inverterRealtime: invRt, batteryRealtime: battRt, plantRealtime: plantRt };

  const invs = Array.isArray(invRt) ? invRt : [];
  const batts = Array.isArray(battRt) ? battRt : [];
  const p = plantRt && !plantRt.error ? plantRt : {};

  const pvW = sum(invs.map(pvPower));
  const acW = sum(invs.map(d => num(d.totalActivePower) ?? sum([num(d.acPower1), num(d.acPower2), num(d.acPower3)])));
  const gridRaw = sum(invs.map(d => num(d.gridPower)));
  const gridW = gridRaw === null ? null : gridRaw * GRID_SIGN;          // + export, − import
  const battRaw = sum(batts.map(b => num(b.chargeDischargePower)));
  const batteryW = battRaw === null ? null : battRaw * BATT_SIGN;       // + charging, − discharging
  const socs = batts.map(b => num(b.batterySOC)).filter(v => v !== null);
  const soc = socs.length ? socs.reduce((a, b) => a + b, 0) / socs.length : null;
  // House load = solar − battery charging − export (all in W)
  const loadW = pvW !== null && gridW !== null ? Math.max(0, pvW - (batteryW || 0) - gridW) : null;
  const times = [...invs, ...batts].map(d => d.dataTime).filter(Boolean).sort();

  return {
    ok: true,
    // SolaX often names the plant after the account email; don't show that on the page
    plantName: inv.plant.plantName && !/@/.test(inv.plant.plantName) ? inv.plant.plantName : null,
    batteryCapacityKwh: num(inv.plant.batteryCapacity),
    pvCapacityKw: num(inv.plant.pvCapacity),
    dataTime: times.at(-1) || null,
    pvW, acW, gridW, batteryW, soc, loadW,
    today: {
      yieldKwh: num(p.dailyYield) ?? sum(invs.map(d => num(d.dailyYield))),
      importKwh: num(p.dailyImported),
      exportKwh: num(p.dailyExported),
      chargedKwh: num(p.dailyCharged),
      dischargedKwh: num(p.dailyDischarged),
    },
  };
}

// ---------- System profile (used to pre-fill dashboard settings) ----------
let profile = null, profileAt = 0;

async function statMonth(plantId, ym) {
  const t = await getToken();
  const r = await fetch(`${BASE}/openapi/v2/plant/energy/get_stat_data`, {
    method: "POST",
    headers: { Authorization: `bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({ plantId, dateType: 2, date: ym, businessType: BUSINESS_TYPE }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 10000) return [];
  return (j.result && j.result.plantEnergyStatDataList) || [];
}

async function averageDailyUse(plantId) {
  // Daily rows for this month and last; use the most recent 14 complete days
  const now = new Date();
  const ym = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const rows = [...await statMonth(plantId, ym(prev)), ...await statMonth(plantId, ym(now))];
  const vals = rows.map(r => num(r.loadConsumption)).filter(v => v !== null && v > 0);
  // The last row is today (incomplete); drop it if this month returned rows
  const complete = vals.length > 1 ? vals.slice(0, -1) : vals;
  const recent = complete.slice(-14);
  return recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
}

async function getProfile() {
  if (profile && Date.now() - profileAt < 6 * 3600e3) return profile;
  const inv = await getInventory();
  const pl = inv.plant;
  const rated = sum(inv.inverters.map(d => num(d.ratedPower)));
  const ratedKw = rated === null ? null : rated > 100 ? rated / 1000 : rated; // W or kW
  const battRated = sum(inv.batteries.map(d => num(d.ratedCapacity)));
  profile = {
    pvCapacityKw: num(pl.pvCapacity),
    batteryCapacityKwh: num(pl.batteryCapacity) || battRated,
    inverterRatedKw: ratedKw,
    avgDailyUseKwh: await averageDailyUse(pl.plantId).catch(() => null),
    lat: num(pl.latitude), lon: num(pl.longitude),
  };
  profileAt = Date.now();
  return profile;
}

async function getLive() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  if (!inflight) {
    inflight = Promise.all([fetchLive(), getProfile().catch(() => null)])
      .then(([d, prof]) => { d.profile = prof; return d; })
      .then(d => { cache = { ...d, fetchedAt: new Date().toISOString() }; cacheAt = Date.now(); return cache; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// ---------- HTTP ----------
function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function authorised(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const pass = Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":");
  return pass === PASSWORD;
}

const STATIC = { "/": "index.html", "/index.html": "index.html" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/healthz") return send(res, 200, { ok: true });
  if (!authorised(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Ashgrove Electricity Hub"' });
    return res.end("Password required");
  }

  if (url.pathname === "/api/solax") {
    if (!CLIENT_ID || !CLIENT_SECRET) return send(res, 200, { ok: false, configured: false, error: "SolaX not configured" });
    try { return send(res, 200, await getLive()); }
    catch (e) { console.error(e); return send(res, 200, { ok: false, configured: true, error: e.message }); }
  }
  if (url.pathname === "/api/solax/raw") {
    if (!CLIENT_ID || !CLIENT_SECRET) return send(res, 200, { ok: false, configured: false });
    try { return send(res, 200, await fetchLive({ raw: true })); }
    catch (e) { return send(res, 200, { ok: false, error: e.message }); }
  }

  const file = STATIC[url.pathname];
  if (!file) return send(res, 404, "Not found", "text/plain");
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) return send(res, 500, "Error", "text/plain");
    send(res, 200, data, "text/html; charset=utf-8");
  });
});

server.listen(PORT, () => console.log(`Ashgrove Electricity Hub on http://localhost:${PORT} (SolaX ${CLIENT_ID ? "configured" : "not configured"})`));
