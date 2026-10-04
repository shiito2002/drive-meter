'use strict';
const $ = id => document.getElementById(id);
const app = $('app');

// ===================== 設定 =====================
const DEFAULTS = { target: 60, tol: 10, winMin: 5, layout: 'auto', beep: false, altOffset: -35, refresh: 1, barHalf: 20,
                   muniSound: true };
const S = loadJSON('drv.settings', DEFAULTS);
function loadJSON(key, def) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ? Object.assign({}, def, v) : { ...def }; }
  catch { return { ...def }; }
}
function saveSettings() { try { localStorage.setItem('drv.settings', JSON.stringify(S)); } catch {} }

// ===================== 記録データ =====================
// RT: 記録時間[s]（一時停止・GPS途切れを除いた経過）, T: 時刻[ms], V: 速度[km/h], A: 高度[m],
// B: 1 = 直前と途切れている（グラフの線をつながない）
// M: 通過した市町村 [{ i: 記録点の番号, n: 市町村名 }]
// id / name / savedLen: 保存済みならその記録のID・名前・保存時点の点数
function newSession() {
  return { RT: [], T: [], V: [], A: [], LAT: [], LNG: [], B: [], M: [],
           dist: 0, moving: 0, recTime: 0, maxV: 0, maxI: -1, gain: 0, loss: 0, altRef: null };
}
const validData = d => d && Array.isArray(d.V) && Array.isArray(d.RT) && d.V.length === d.RT.length;
function loadSession() {
  try { const d = JSON.parse(localStorage.getItem('drv.session')); return validData(d) ? d : null; }
  catch { return null; }
}
let D = loadSession() || newSession();
D.M = D.M || [];
const unsaved = () => D.V.length > 0 && D.V.length !== (D.savedLen || 0);

let rec = false;          // 記録中か
let demo = null;          // デモ走行の生成関数
let demoTimer = null;
let watchId = null;
let lastFix = 0, lastAcc = null, lastAltAcc = null, liveV = null;
let altS = lastNonNull(D.A);   // 平滑化した高度
let altSrc = null;              // 'dem'（国土地理院） / 'gps'
let altT = 0;                   // 標高を最後に更新した時刻
let warn = null;          // null / 'fast'（超過） / 'slow'（低下）
let view = null;          // 見返し中の記録 { id, name, R, ci }
let wakeLock = null, audioCtx = null, dirty = false;

const GAP_SEC = 10;       // これ以上空いたら途切れ扱い
const MAX_ACC = 50;       // 精度[m]がこれより悪い点は捨てる
const STOP_KMH = 5;       // これ未満は停車扱い（低下警告なし）
const ALT_STEP = 3;       // 累積上昇で無視する揺れ[m]

function lastNonNull(a) { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; }
const r1 = x => Math.round(x * 10) / 10;
const r6 = x => Math.round(x * 1e6) / 1e6;
const p2 = n => String(n).padStart(2, '0');
const hhmm = ts => { const d = new Date(ts); return `${d.getHours()}:${p2(d.getMinutes())}`; };
const ymd = ts => { const d = new Date(ts); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = s => `${Math.floor(s / 3600)}:${p2(Math.floor(s / 60) % 60)}`;
const fmtDist = km => km < 100 ? km.toFixed(1) : String(Math.round(km));
const fmtMS = s => `${Math.floor(s / 60)}:${p2(Math.floor(s % 60))}`;
const winLabel = sec => sec < 60 ? `${Math.round(sec)}秒` : `${+(sec / 60).toFixed(1)}分`;

function hav(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ===================== GPS =====================
function startGps() {
  if (watchId != null) return;
  if (!navigator.geolocation) { alert('この端末では位置情報が使えません'); return; }
  watchId = navigator.geolocation.watchPosition(onPosition, onGpsError,
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  updateGpsStatus();
}
function onGpsError(e) {
  if (e.code === 1) {
    alert('位置情報の使用が許可されていません。\nChrome のサイト設定で「位置情報」を許可してください。');
    navigator.geolocation.clearWatch(watchId); watchId = null;
  }
  updateGpsStatus();
}

function onPosition(pos) {
  if (demo && !pos.demo) return;           // デモ中は実GPSを無視
  const c = pos.coords;
  lastFix = Date.now(); lastAcc = c.accuracy; lastAltAcc = c.altitudeAccuracy ?? null;

  const n = D.T.length;
  const t = pos.timestamp;
  const dt = n ? (t - D.T[n - 1]) / 1000 : 0;
  const gap = !n || dt > GAP_SEC;

  let v = (c.speed != null && !isNaN(c.speed)) ? c.speed * 3.6 : null;
  if (v == null) v = (n && !gap && dt > 0) ? hav(D.LAT[n - 1], D.LNG[n - 1], c.latitude, c.longitude) / dt * 3.6 : 0;
  if (v < 1.5) v = 0;
  liveV = v;
  updateWarn(v);
  if (c.accuracy <= MAX_ACC) maybeQueryMuni(c.latitude, c.longitude, v);
  if (!pos.demo) imuOnGps(t, v, c.accuracy);
  if (c.accuracy > MAX_ACC) { requestRender(); return; }

  // 標高：国土地理院の標高タイルを優先し、取れないときはGPSの高度（＋補正値）。記録していないときも表示用に更新
  const dem = demo ? undefined : demAt(c.latitude, c.longitude);
  const src = dem !== undefined ? 'dem' : 'gps';
  const raw = dem !== undefined ? dem : c.altitude != null ? c.altitude + S.altOffset : null;
  const switched = altSrc != null && src !== altSrc;
  if (raw != null) {
    const fresh = altS == null || switched || t - altT > GAP_SEC * 1000;
    altS = fresh ? raw : altS + (raw - altS) * (src === 'dem' ? 0.5 : 0.15);
    altSrc = src; altT = t;
  }
  const a = altS;

  if (!rec || (n && dt <= 0)) { requestRender(); return; }

  if (!gap) {
    D.recTime += dt;
    D.dist += (D.V[n - 1] + v) / 2 * dt / 3600;
    if (v >= STOP_KMH) D.moving += dt;
  }
  if (a != null) {
    if (D.altRef == null || gap || switched) D.altRef = a;   // 途切れ・取得元の切り替えでの段差は数えない
    const da = a - D.altRef;
    if (da >= ALT_STEP) { D.gain += da; D.altRef = a; }
    else if (da <= -ALT_STEP) { D.loss -= da; D.altRef = a; }
  }

  D.RT.push(r1(D.recTime)); D.T.push(t); D.V.push(r1(v)); D.A.push(a == null ? null : r1(a));
  D.LAT.push(r6(c.latitude)); D.LNG.push(r6(c.longitude)); D.B.push(gap ? 1 : 0);
  if (v > D.maxV) { D.maxV = v; D.maxI = D.V.length - 1; }
  const lastM = D.M[D.M.length - 1];
  if (muni.name && (!lastM || lastM.n !== muni.name)) D.M.push({ i: D.V.length - 1, n: muni.name });

  dirty = true;
  requestRender();
}

// ===================== 市町村（国土地理院 住所検索API） =====================
const MUNI_TABLE_URL = 'https://maps.gsi.go.jp/js/muni.js';
const RGEO_URL = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';
const MUNI_INTERVAL = 20000;   // 問い合わせ間隔[ms]
let muniTable = null;
try { muniTable = JSON.parse(localStorage.getItem('drv.muniTable')); } catch {}
const muni = { name: null, cand: null, candN: 0, lastQ: 0, lastLat: null, lastLng: null, busy: false };

async function ensureMuniTable() {
  if (muniTable) return muniTable;
  const txt = await (await fetch(MUNI_TABLE_URL)).text();
  const t = {};
  for (const m of txt.matchAll(/MUNI_ARRAY\["(\d+)"\]\s*=\s*'([^']*)'/g)) {
    t[m[1]] = m[2].split(',')[3].split('　')[0];       // 「札幌市　中央区」→「札幌市」
  }
  muniTable = t;
  try { localStorage.setItem('drv.muniTable', JSON.stringify(t)); } catch {}
  return t;
}
async function queryMuni(lat, lng) {
  const [t, j] = await Promise.all([ensureMuniTable(),
    fetch(`${RGEO_URL}?lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}`).then(r => r.json())]);
  const cd = j && j.results && j.results.muniCd;
  return cd ? (t[String(parseInt(cd, 10))] || null) : null;   // 海の上などは null
}
// デモ走行用：走行距離で市町村が変わったことにする
function demoMuni() {
  const km = D.dist % 80;
  return km < 15 ? '北見市' : km < 35 ? '訓子府町' : km < 60 ? '置戸町' : '北見市';
}
function maybeQueryMuni(lat, lng, v) {
  const now = Date.now(), interval = demo ? 2000 : MUNI_INTERVAL;
  if (muni.busy || now - muni.lastQ < interval) return;
  if (muni.name && v < STOP_KMH && muni.lastLat != null && hav(muni.lastLat, muni.lastLng, lat, lng) < 100) return;  // 止まっている
  muni.busy = true; muni.lastQ = now; muni.lastLat = lat; muni.lastLng = lng;
  (demo ? Promise.resolve(demoMuni()) : queryMuni(lat, lng))
    .then(name => { if (name) onMuni(name); })
    .catch(() => {})
    .finally(() => { muni.busy = false; });
}
// 境目で行ったり来たりしないよう、2回続けて同じ新しい市町村なら切り替える
function onMuni(name) {
  if (name === muni.name) { muni.cand = null; return; }
  if (!muni.name) { muni.name = name; requestRender(); return; }
  if (muni.cand === name && ++muni.candN >= 2) {
    const from = muni.name;
    muni.name = name; muni.cand = null;
    showNotice(from, name);
    requestRender();
  } else if (muni.cand !== name) {
    muni.cand = name; muni.candN = 1;
    muni.lastQ = Date.now() - (demo ? 2000 : MUNI_INTERVAL) + 5000;   // 確認のため5秒後にもう一度
  }
}
let noticeTimer = null;
function showNotice(from, to) {
  $('noticeFrom').textContent = `${from} →`;
  $('noticeTo').textContent = to;
  $('notice').classList.add('show');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => $('notice').classList.remove('show'), 3000);
  if (S.muniSound) chime();
}
function chime() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [[880, 0], [1318.5, 0.16]].forEach(([f, dt]) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + dt); g.gain.exponentialRampToValueAtTime(0.25, t + dt + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.5);
    o.connect(g).connect(audioCtx.destination); o.start(t + dt); o.stop(t + dt + 0.55);
  });
}
// 記録の i 番目の地点の市町村
function muniAtIndex(d, i) {
  let name = null;
  for (const m of d.M || []) { if (m.i <= i) name = m.n; else break; }
  return name;
}

// ===================== 標高（国土地理院 標高タイル） =====================
// 10mメッシュの標高PNGタイル（z14 ≒ 1.8km四方）。取得したタイルは端末に保存して電波がなくても使う
const DEM_Z = 14;
const demUrl = (x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${DEM_Z}/${x}/${y}.png`;
const demTiles = new Map();   // "x/y" → Float32Array（標高[m]、なしはNaN） / null（タイルなし） / 'loading'
function tileXY(lat, lng) {
  const n = 2 ** DEM_Z, r = lat * Math.PI / 180;
  const xf = (lng + 180) / 360 * n, yf = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
  const x = Math.floor(xf), y = Math.floor(yf);
  return { x, y, key: x + '/' + y, i: Math.min(255, Math.floor((yf - y) * 256)) * 256 + Math.min(255, Math.floor((xf - x) * 256)) };
}
async function loadDemTile(x, y) {
  const key = x + '/' + y;
  if (demTiles.has(key)) return demTiles.get(key);
  demTiles.set(key, 'loading');
  try {
    const url = demUrl(x, y);
    const cache = await caches.open('dem-tiles');
    let res = await cache.match(url);
    if (!res) {
      res = await fetch(url);
      if (res.status === 404) { demTiles.set(key, null); return null; }   // 海など
      if (!res.ok) throw new Error(res.status);
      await cache.put(url, res.clone());
    }
    const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const cv = new OffscreenCanvas(256, 256), ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, 256, 256).data, out = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) {
      const v = px[i * 4] * 65536 + px[i * 4 + 1] * 256 + px[i * 4 + 2];
      out[i] = v === 8388608 ? NaN : (v < 8388608 ? v : v - 16777216) * 0.01;
    }
    if (demTiles.size > 80) demTiles.delete(demTiles.keys().next().value);   // 古いものから捨てる
    demTiles.set(key, out);
    return out;
  } catch {
    setTimeout(() => demTiles.delete(key), 30000);   // 電波がないときは30秒後に再挑戦
    return null;
  }
}
// その地点の標高。まだタイルがなければ読み込みを始めて undefined
function demAt(lat, lng) {
  const t = tileXY(lat, lng), tile = demTiles.get(t.key);
  if (tile === undefined) { loadDemTile(t.x, t.y); return undefined; }
  if (!(tile instanceof Float32Array) || isNaN(tile[t.i])) return undefined;
  return tile[t.i];
}
// ===================== トンネル内の速度推定（加速度センサー） =====================
// GPSが良い間に「端末の加速度ベクトル → 車の前後加速度」の対応を学習しておき、
// GPSが途切れたら最後の速度から加速度を積分して推定する（推定中は灰色で表示）。
// 実機で確かめたこと：スマホのGPS速度は加速度より2〜3秒遅れて変化し、1秒ごとの速度差はばらつきが大きい。
// そこで「3秒間の速度差」と「遅れ分ずらした3秒間の平均加速度」を比べ、遅れ（0〜4秒）も自動で選ぶ。
const IMU = {
  hist: [],                     // GPS更新ごとの { t, v[m/s], m:[x,y,z] その間の平均加速度, ok }
  model: null,                  // 学習結果 { u: 前方向（単位ベクトル）, s: 倍率, beta: 補正, lag: 遅れ[秒], corr: 相関 }
  fit: { n: 0, corr: 0 },       // 直近の学習の状況（設定画面に表示）
  lastFit: 0,
  sum: [0, 0, 0], cnt: 0,       // GPS更新の間の加速度の合計
  lastT: 0, prevGps: null,      // 前回のセンサー時刻 / 前回のGPS { t, v[m/s] }
  lp: [0, 0, 0], vib: 0, vibStop: null, vibMove: null, still: 0,   // 細かい振動の大きさ（停車判定用）
  est: null,                    // 推定中 { v[m/s], since[ms] }
  events: 0,
};
const IMU_W = 3;                // 速度差を見る幅[秒]
const IMU_MAXLAG = 4;           // 試すGPSの遅れ[秒]
const IMU_MIN_PAIRS = 90;       // 学習に使う組の最低数（約1.5分ぶん）
const IMU_MIN_CORR = 0.35;      // これ以上の相関があれば採用
try {
  const L = JSON.parse(localStorage.getItem('drv.imu'));
  if (L && L.model) { IMU.model = L.model; IMU.fit = { n: L.model.n, corr: L.model.corr }; }
  if (L) { IMU.vibStop = L.vibStop ?? null; IMU.vibMove = L.vibMove ?? null; }
} catch {}
function saveImu() {
  if (!IMU.model && IMU.vibMove == null) return;
  try { localStorage.setItem('drv.imu', JSON.stringify({ model: IMU.model, vibStop: IMU.vibStop, vibMove: IMU.vibMove })); } catch {}
}

addEventListener('devicemotion', e => {
  const a = e.acceleration;     // 重力を除いた加速度（端末の座標系）
  if (!a || a.x == null) return;
  const now = performance.now(), dt = IMU.lastT ? Math.min(0.2, (now - IMU.lastT) / 1000) : 0;
  IMU.lastT = now; IMU.events++;
  imuSample(a.x, a.y, a.z, dt);
});

const imuForward = (md, x, y, z) => md.s * (md.u[0] * x + md.u[1] * y + md.u[2] * z - md.beta);

function imuSample(x, y, z, dt) {
  IMU.sum[0] += x; IMU.sum[1] += y; IMU.sum[2] += z; IMU.cnt++;
  // 細かい振動だけを見る（0.3秒より遅い加減速は除く）→ 約1秒の二乗平均
  const k = Math.min(1, dt / 0.3), lp = IMU.lp;
  lp[0] += (x - lp[0]) * k; lp[1] += (y - lp[1]) * k; lp[2] += (z - lp[2]) * k;
  const hx = x - lp[0], hy = y - lp[1], hz = z - lp[2];
  IMU.vib += (hx * hx + hy * hy + hz * hz - IMU.vib) * Math.min(1, dt);
  const E = IMU.est;
  if (!E || dt <= 0) return;
  if (IMU.model) E.v = Math.min(70, Math.max(0, E.v + imuForward(IMU.model, x, y, z) * dt));
  // 振動がほとんどない状態が続いたら停車とみなす（停車中と走行中の振動を学習済みのときだけ）
  if (IMU.vibStop != null && IMU.vibMove != null && IMU.vibMove > IMU.vibStop * 3) {
    const thr = Math.sqrt(IMU.vibStop * IMU.vibMove);
    IMU.still = IMU.vib < thr ? IMU.still + dt : 0;
    if (IMU.still > (E.v < 7 ? 2 : 5)) E.v = 0;          // 推定がまだ速いときは慎重に（5秒）
  }
}

// GPSを受信するたび：推定を終了し、学習用の記録を足す
function imuOnGps(t, vKmh, acc) {
  IMU.est = null;
  const v = vKmh / 3.6, p = IMU.prevGps, last = IMU.hist[IMU.hist.length - 1];
  if (IMU.cnt) {
    const ok = acc <= 20 && !!last && t - last.t >= 500 && t - last.t <= 2500;
    IMU.hist.push({ t, v, m: IMU.sum.map(x => x / IMU.cnt), ok });
    if (IMU.hist.length > 900) IMU.hist.shift();            // 直近15分ぶん
    if (acc <= 20) {
      if (v < 0.3 && p && p.v < 0.3) IMU.vibStop = IMU.vibStop == null ? IMU.vib : IMU.vibStop + (IMU.vib - IMU.vibStop) * 0.05;
      if (v > 8) IMU.vibMove = IMU.vibMove == null ? IMU.vib : IMU.vibMove + (IMU.vib - IMU.vibMove) * 0.05;
    }
  }
  IMU.sum = [0, 0, 0]; IMU.cnt = 0;
  if (acc <= MAX_ACC) IMU.prevGps = { t, v };
  if (t - IMU.lastFit > 20000) { IMU.lastFit = t; imuFit(); }
}

// 直近の記録から、遅れ 0〜4秒それぞれで「前方向・倍率・補正・相関」を求め、いちばん合うものを採用する
function imuFit() {
  const H = IMU.hist, W = IMU_W, mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  let best = null;
  for (let lag = 0; lag <= IMU_MAXLAG; lag++) {
    const A = [], Mw = [];
    for (let i = W + lag; i < H.length; i++) {
      let ok = H[i].v > 1.5;
      for (let j = i - W - lag + 1; j <= i && ok; j++) ok = H[j].ok;
      if (!ok) continue;
      A.push((H[i].v - H[i - W].v) / ((H[i].t - H[i - W].t) / 1000));
      const w = [0, 0, 0];
      for (let j = i - W + 1 - lag; j <= i - lag; j++) for (let c = 0; c < 3; c++) w[c] += H[j].m[c] / W;
      Mw.push(w);
    }
    if (A.length < 20) continue;
    const ma = mean(A), va = mean(A.map(a => (a - ma) ** 2));
    if (va < 0.005) continue;                                  // 加減速がほとんどない
    const mm = [0, 1, 2].map(c => mean(Mw.map(w => w[c])));
    const g = [0, 1, 2].map(c => mean(Mw.map((w, i) => (w[c] - mm[c]) * (A[i] - ma))) / va);
    const gl = Math.hypot(...g);
    if (!gl) continue;
    const u = g.map(x => x / gl);
    const P = Mw.map(w => u[0] * w[0] + u[1] * w[1] + u[2] * w[2]), mp = mean(P);
    const vp = mean(P.map(x => (x - mp) ** 2)), cpa = mean(P.map((x, i) => (x - mp) * (A[i] - ma)));
    const corr = cpa / Math.sqrt(vp * va);
    if (!best || corr > best.corr) {
      const s = Math.min(1.8, Math.max(0.7, cpa / vp));
      best = { u, s, beta: mp - ma / s, lag, corr, n: A.length };
    }
  }
  if (!best) return;
  IMU.fit = { n: best.n, corr: best.corr };
  if (best.n >= IMU_MIN_PAIRS && best.corr >= IMU_MIN_CORR) { IMU.model = best; saveImu(); }
}

// 走行中にGPSが2.5秒以上途切れたら推定を始める
function imuMaybeStart() {
  if (IMU.est || demo || watchId == null || !IMU.prevGps || !IMU.lastT) return;
  const lost = Date.now() - lastFix;
  if (lost > 2500 && IMU.prevGps.v * 3.6 >= STOP_KMH && performance.now() - IMU.lastT < 1000) {
    let v = IMU.prevGps.v;
    const md = IMU.model;
    if (md) {
      // GPS速度の遅れぶん（直前 lag 秒）と、途切れてからの2.5秒ぶんの加速度を足しておく
      if (md.lag) for (const h of IMU.hist.slice(-md.lag)) v += imuForward(md, ...h.m);
      if (IMU.cnt) v += imuForward(md, ...IMU.sum.map(x => x / IMU.cnt)) * lost / 1000;
    }
    IMU.est = { v: Math.max(0, v), since: lastFix };
    IMU.still = 0;
  }
}

function recomputeGain(d) {
  let ref = null;
  d.gain = 0; d.loss = 0;
  for (let i = 0; i < d.A.length; i++) {
    const a = d.A[i];
    if (a == null) continue;
    if (ref == null || d.B[i]) { ref = a; continue; }
    const da = a - ref;
    if (da >= ALT_STEP) { d.gain += da; ref = a; }
    else if (da <= -ALT_STEP) { d.loss -= da; ref = a; }
  }
}

function updateGpsStatus() {
  const el = $('gps');
  let cls = '', txt;
  if (view) {           // 見返し中はカーソル位置の時刻
    cls = 'view'; txt = view.R.T.length ? `${hhmm(view.R.T[view.ci])} 地点` : '';
  }
  else if (!demo && watchId == null) txt = 'GPS オフ';
  else if (!lastFix) txt = 'GPS 測位中…';
  else if (IMU.est) { cls = 'est'; txt = 'GPSなし・加速度で推定中'; }
  else if (Date.now() - lastFix > 5000) { cls = 'bad'; txt = 'GPS 受信なし'; }
  else {
    // 位置の精度（＋取れれば高度の精度）
    txt = `精度±${Math.round(lastAcc)}m`;                    // デモ中は紫色で表示
    if (lastAltAcc != null) txt += ` 高度±${Math.round(lastAltAcc)}m`;
    cls = demo ? 'demo' : lastAcc <= 15 ? 'good' : lastAcc <= MAX_ACC ? 'fair' : 'bad';
  }
  el.className = 'gps ' + cls; el.textContent = txt;
}
setInterval(() => {
  imuMaybeStart();
  updateGpsStatus();
  if (liveV != null && Date.now() - lastFix > 5000) { liveV = null; warn = null; requestRender(); }
  if (IMU.est) requestRender();
}, 1000);

// ===================== 警告・色 =====================
function updateWarn(v) {
  const d = v - S.target;
  const stopped = v < STOP_KMH && d < 0;
  const was = warn;
  if (stopped) warn = null;
  else if (Math.abs(d) > S.tol) warn = d > 0 ? 'fast' : 'slow';
  else if (warn && Math.abs(d) < S.tol - 1) warn = null;    // ±1km/h のヒステリシス
  if (warn && warn !== was && S.beep) beep(warn === 'fast');
}
// 見返し用（ヒステリシスなし）
function warnOf(v) {
  if (v == null) return null;
  const d = v - S.target;
  return d > S.tol ? 'fast' : (d < -S.tol && v >= STOP_KMH) ? 'slow' : null;
}

// 設定速度との差で 青 ← 緑 → 赤 に混色
function colorFor(v) {
  const r = Math.max(-1, Math.min(1, (v - S.target) / S.tol));
  const g = [52, 211, 153], b = [59, 130, 246], rd = [239, 68, 68];
  const c = r < 0 ? b : rd, t = Math.abs(r);
  return `rgb(${g.map((x, k) => Math.round(x + (c[k] - x) * t)).join(',')})`;
}
// 高度グラフの色：色を持たない明るいグレー（速度の青・緑・赤を目立たせる）
const ALT = { line: '#d4dbe6', label: '#cbd5e1', fillTop: '#94a3b866', fillBottom: '#94a3b812', spark: '#94a3b84d' };
const scaleMax = () => Math.max(100, Math.ceil((S.target + S.tol) * 1.5 / 20) * 20);

function ensureAudio() {
  if (!audioCtx && window.AudioContext) audioCtx = new AudioContext();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
function beep(high) {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime;
  o.frequency.value = high ? 1320 : 660;
  g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
  o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.35);
}

// ===================== 設定速度をタップで ±10 =====================
let toastTimer = null;
$('speedbox').addEventListener('click', e => {
  const r = $('speedbox').getBoundingClientRect();
  const step = e.clientX - r.left < r.width / 2 ? -10 : 10;
  S.target = Math.min(200, Math.max(10, S.target + step));
  saveSettings();
  if (liveV != null) updateWarn(liveV);
  $('toast').textContent = `設定 ${S.target} km/h`;
  $('toast').classList.add('show'); $('dTarget').classList.add('flash');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').classList.remove('show'); $('dTarget').classList.remove('flash'); }, 800);
  renderNow();
});

// ===================== 記録の開始・停止 =====================
async function requestWake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); }
  catch {}
}
function releaseWake() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }

// 記録中かどうかを端末に残し、再読み込みやアプリの再起動後も記録を続ける
function setRecFlag(on) { try { on ? localStorage.setItem('drv.rec', '1') : localStorage.removeItem('drv.rec'); } catch {} }
function startRec() {
  ensureAudio();
  if (!demo) startGps();
  rec = true; requestWake(); updateRecBtn();
  if (!demo) setRecFlag(true);
}
function stopRec() {
  rec = false; releaseWake(); save(); updateRecBtn();
  setRecFlag(false);
}
function updateRecBtn() {
  const b = $('btnRec');
  b.textContent = rec ? '⏸' : '▶';
  b.classList.toggle('on', rec);
  b.setAttribute('aria-label', rec ? '一時停止' : '記録開始');
}
$('btnRec').onclick = () => rec ? stopRec() : startRec();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && rec) requestWake();
  if (document.visibilityState === 'hidden') save();
});
addEventListener('pagehide', save);

// 記録中のドライブを端末に一時保存（アプリを閉じても続きから）
function save() {
  saveImu();
  if (demo || !dirty) return;
  try { localStorage.setItem('drv.session', JSON.stringify(D)); dirty = false; } catch {}
}
setInterval(save, 15000);

function resetSession() {
  D = newSession(); dirty = false;
  try { localStorage.removeItem('drv.session'); } catch {}
  renderNow();
}

// ===================== 保存した記録（IndexedDB） =====================
// meta: 一覧用の要約と小さなグラフ用データ / data: 全データ
const store = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('drive-meter', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('meta', { keyPath: 'id' });
      r.result.createObjectStore('data', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  async function run(names, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(names, mode);
      const req = fn(t);
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = t.onabort = () => rej(t.error);
    });
  }
  return {
    list: () => run('meta', 'readonly', t => t.objectStore('meta').getAll()),
    meta: id => run('meta', 'readonly', t => t.objectStore('meta').get(id)),
    load: id => run('data', 'readonly', t => t.objectStore('data').get(id)),
    put: (meta, data) => run(['meta', 'data'], 'readwrite', t => {
      t.objectStore('meta').put(meta); t.objectStore('data').put(data);
    }),
    rename: (id, name) => run('meta', 'readwrite', t => {
      const st = t.objectStore('meta');
      st.get(id).onsuccess = e => { const m = e.target.result; if (m) { m.name = name; st.put(m); } };
    }),
    del: id => run(['meta', 'data'], 'readwrite', t => {
      t.objectStore('meta').delete(id); t.objectStore('data').delete(id);
    }),
  };
})();

function makeMeta(id, name, d) {
  const n = d.V.length, K = Math.min(120, n), sv = [], sa = [];
  for (let k = 0; k < K; k++) {          // 一覧の小さなグラフ用に120点へ間引き
    const i0 = Math.floor(k * n / K), i1 = Math.floor((k + 1) * n / K);
    let s = 0, c = 0, as = 0, ac = 0;
    for (let i = i0; i < i1; i++) { s += d.V[i]; c++; if (d.A[i] != null) { as += d.A[i]; ac++; } }
    sv.push(c ? r1(s / c) : 0); sa.push(ac ? r1(as / ac) : null);
  }
  const route = [];
  for (const m of d.M || []) if (route[route.length - 1] !== m.n) route.push(m.n);
  return { id, name, start: d.T[0], end: d.T[n - 1], dist: d.dist, recTime: d.recTime, maxV: d.maxV, sv, sa,
           route, demFixed: !!d.demFixed };
}
const defaultName = d => `${new Date(d.T[0]).getMonth() + 1}/${new Date(d.T[0]).getDate()} ${hhmm(d.T[0])} のドライブ`;
const rangeLabel = (a, b) => `${ymd(a)} ${hhmm(a)} 〜 ${ymd(a) === ymd(b) ? '' : ymd(b) + ' '}${hhmm(b)}`;
const statsLine = (dist, sec, maxV) =>
  `<span><b>${fmtDist(dist)}</b> km</span><span><b>${fmtTime(sec)}</b></span><span>最高 <b>${Math.round(maxV)}</b> km/h</span>`;

async function saveCurrent() {
  if (!D.V.length) return;
  const res = await askName(D.id ? '保存（上書き）' : '名前を付けて保存', D.name || defaultName(D),
    `${fmtDist(D.dist)} km ／ ${fmtTime(D.recTime)} ／ 最高 ${Math.round(D.maxV)} km/h`, true);
  if (!res) return;
  D.id = D.id || 'd' + Date.now();
  D.name = res.name;
  D.savedLen = D.V.length;
  try {
    await store.put(makeMeta(D.id, D.name, D), { id: D.id, d: JSON.parse(JSON.stringify(D)) });
  } catch { alert('保存できませんでした'); return; }
  dirty = true; save();
  if (res.startNew) resetSession();
  showRecords();
}

async function exportDrives(ids, fname) {
  const metas = (await store.list()).filter(m => !ids || ids.includes(m.id));
  const drives = [];
  for (const m of metas) { const x = await store.load(m.id); if (x) drives.push({ ...m, data: x.d }); }
  if (!drives.length) { alert('書き出す記録がありません'); return; }
  download(new Blob([JSON.stringify({ app: 'drive-meter', version: 1, drives })], { type: 'application/json' }), fname);
}
function download(blob, fname) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// GPX 1.1（速度は Garmin の TrackPointExtension に m/s で入れる）。途切れたところで区間を分ける
function buildGpx(name, d) {
  const iso = t => new Date(t).toISOString();
  let segs = '', seg = '';
  for (let i = 0; i < d.V.length; i++) {
    if (i && d.B[i]) { segs += `  <trkseg>
${seg}  </trkseg>
`; seg = ''; }
    seg += `   <trkpt lat="${d.LAT[i]}" lon="${d.LNG[i]}">${d.A[i] != null ? `<ele>${d.A[i]}</ele>` : ''}<time>${iso(d.T[i])}</time>`
         + `<extensions><gpxtpx:TrackPointExtension><gpxtpx:speed>${(d.V[i] / 3.6).toFixed(2)}</gpxtpx:speed></gpxtpx:TrackPointExtension></extensions></trkpt>
`;
  }
  if (seg) segs += `  <trkseg>
${seg}  </trkseg>
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="ドライブ速度計" xmlns="http://www.topografix.com/GPX/1/1"
 xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2">
 <metadata><name>${esc(name)}</name><time>${iso(d.T[0])}</time></metadata>
 <trk>
  <name>${esc(name)}</name>
${segs} </trk>
</gpx>
`;
}
async function exportGpx(m) {
  const x = await store.load(m.id);
  if (!x) { alert('記録が見つかりません'); return; }
  download(new Blob([buildGpx(m.name, x.d)], { type: 'application/gpx+xml' }),
    `drive_${fileStamp(m.start)}_${safeName(m.name)}.gpx`);
}

// 保存済みの記録の標高を、国土地理院の標高タイルで置き換える
async function fixElevation(m, btn) {
  const x = await store.load(m.id);
  if (!x) return;
  const d = x.d, groups = new Map();
  for (let i = 0; i < d.V.length; i++) {          // 必要なタイルごとに記録点をまとめる
    const t = tileXY(d.LAT[i], d.LNG[i]);
    if (!groups.has(t.key)) groups.set(t.key, { t, idx: [] });
    groups.get(t.key).idx.push([i, t.i]);
  }
  let k = 0, fixed = 0;
  for (const { t, idx } of groups.values()) {
    btn.textContent = `補正中 ${++k}/${groups.size}`;
    let tile = await loadDemTile(t.x, t.y);
    if (tile === 'loading') { await new Promise(r => setTimeout(r, 500)); tile = demTiles.get(t.key); }
    if (!(tile instanceof Float32Array)) continue;
    for (const [i, pi] of idx) if (!isNaN(tile[pi])) { d.A[i] = r1(tile[pi]); fixed++; }
  }
  if (!fixed) { alert('標高データを取得できませんでした（電波を確認してください）'); showRecords(); return; }
  recomputeGain(d);
  d.demFixed = true;
  await store.put(makeMeta(m.id, m.name, d), { id: m.id, d });
  alert(`${fixed} / ${d.V.length} 地点の標高を国土地理院のデータに置き換えました`);
  showRecords();
}
const fileStamp = ts => { const d = new Date(ts); return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`; };
const safeName = s => s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);

$('btnImport').onclick = () => $('fileIn').click();
$('fileIn').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (!j || j.app !== 'drive-meter' || !Array.isArray(j.drives)) throw new Error('format');
    let n = 0;
    for (const x of j.drives) {
      if (!validData(x.data) || !x.data.V.length) continue;
      const id = x.id || 'd' + Date.now() + '_' + n;
      await store.put(makeMeta(id, x.name || defaultName(x.data), x.data), { id, d: x.data });
      n++;
    }
    alert(`${n} 件の記録を読み込みました`);
  } catch { alert('このファイルは読み込めませんでした'); }
  showRecords();
};
$('btnExportAll').onclick = () => exportDrives(null, `drive-meter_all_${fileStamp(Date.now())}.json`);
$('btnSaveCur').onclick = saveCurrent;

// --- 記録一覧 ---
async function showRecords() {
  const cur = $('recCur');
  cur.hidden = !D.V.length;
  if (D.V.length) {
    $('recCurState').textContent = rec ? '● 記録中のドライブ' : '一時停止中のドライブ';
    $('recCurStats').innerHTML = statsLine(D.dist, D.recTime, D.maxV);
    $('recCurSaved').textContent = !D.id ? 'まだ保存していません'
      : unsaved() ? `「${D.name}」の続き（未保存）` : `「${D.name}」として保存済み`;
    $('btnSaveCur').textContent = D.id ? '上書き保存' : '名前を付けて保存';
  }
  let list = [];
  try { list = (await store.list()).sort((a, b) => b.start - a.start); } catch {}
  const box = $('recList');
  box.innerHTML = list.length ? '' : '<p class="empty">保存した記録はまだありません</p>';
  for (const m of list) {
    const el = document.createElement('div');
    el.className = 'item'; el.dataset.id = m.id;
    const route = m.route && m.route.length ? `<div class="route">📍 ${m.route.map(esc).join(' → ')}</div>` : '';
    el.innerHTML = `<div class="n">${esc(m.name)}</div><div class="d">${rangeLabel(m.start, m.end)}</div>
      <div class="s">${statsLine(m.dist, m.recTime, m.maxV)}</div>${route}<canvas></canvas>
      <div class="a"><button class="btn" data-act="open">開く</button><button class="btn" data-act="rename">名前変更</button>
      <button class="btn" data-act="gpx">GPX</button><button class="btn" data-act="export">バックアップ</button>
      ${m.demFixed ? '' : '<button class="btn" data-act="dem">標高補正</button>'}
      <button class="btn dan" data-act="del">削除</button></div>
      ${m.demFixed ? '<div class="d">標高：国土地理院のデータに補正済み</div>' : ''}`;
    box.appendChild(el);
    el._meta = m;
  }
  if (!$('records').open) $('records').showModal();
  box.querySelectorAll('.item').forEach(el => drawSpark(el.querySelector('canvas'), el._meta));
}
$('recList').addEventListener('click', async e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const m = b.closest('.item')._meta;
  if (b.dataset.act === 'open') openDrive(m.id);
  else if (b.dataset.act === 'rename') {
    const res = await askName('名前変更', m.name, rangeLabel(m.start, m.end), false);
    if (!res) return;
    await store.rename(m.id, res.name);
    if (D.id === m.id) { D.name = res.name; dirty = true; save(); }
    showRecords();
  } else if (b.dataset.act === 'gpx') {
    exportGpx(m);
  } else if (b.dataset.act === 'dem') {
    if (b.disabled) return;
    b.disabled = true;
    try { await fixElevation(m, b); } catch { alert('標高の補正に失敗しました'); showRecords(); }
  } else if (b.dataset.act === 'export') {
    exportDrives([m.id], `drive-meter_${fileStamp(m.start)}_${safeName(m.name)}.json`);
  } else if (b.dataset.act === 'del') {
    if (!confirm(`「${m.name}」を削除します。元に戻せません。よろしいですか？`)) return;
    await store.del(m.id);
    if (D.id === m.id) { delete D.id; delete D.name; delete D.savedLen; dirty = true; save(); }
    showRecords();
  }
});
$('btnRecords').onclick = showRecords;
$('btnCloseRecords').onclick = () => $('records').close();

function drawSpark(cv, m) {
  const { ctx, W, H } = prep(cv);
  const n = m.sv.length;
  if (n < 2) return;
  const X = k => k / (n - 1) * W;
  const al = m.sa.filter(a => a != null);
  if (al.length) {
    const lo = Math.min(...al), hi = Math.max(lo + 40, Math.max(...al));
    ctx.beginPath(); ctx.moveTo(0, H);
    m.sa.forEach((a, k) => ctx.lineTo(X(k), a == null ? H : H - (a - lo) / (hi - lo) * H * 0.9));
    ctx.lineTo(W, H); ctx.fillStyle = ALT.spark; ctx.fill();
  }
  const vMax = Math.max(scaleMax(), ...m.sv);
  ctx.lineWidth = 1.5;
  for (let k = 1; k < n; k++) {
    ctx.strokeStyle = colorFor((m.sv[k - 1] + m.sv[k]) / 2);
    ctx.beginPath(); ctx.moveTo(X(k - 1), H - m.sv[k - 1] / vMax * H); ctx.lineTo(X(k), H - m.sv[k] / vMax * H); ctx.stroke();
  }
}

// --- 名前の入力 ---
function askName(title, value, info, showNew) {
  return new Promise(res => {
    const d = $('nameDlg');
    $('nameTitle').textContent = title;
    $('nameIn').value = value;
    $('nameInfo').textContent = info || '';
    $('nameNewRow').hidden = !showNew;
    $('nameNew').checked = false;
    d.returnValue = '';
    d.onclose = () => res(d.returnValue === 'ok' ? { name: $('nameIn').value.trim() || value, startNew: $('nameNew').checked } : null);
    d.showModal();
  });
}
$('nameCancel').onclick = () => $('nameDlg').close('');

// --- 見返しモード ---
async function openDrive(id) {
  let x, m;
  try { [x, m] = await Promise.all([store.load(id), store.meta(id)]); } catch {}
  if (!x || !validData(x.d) || !x.d.V.length) { alert('記録を開けませんでした'); return; }
  view = { id, name: m ? m.name : '', R: x.d, ci: Math.max(0, x.d.maxI) };
  $('records').close();
  $('reviewName').textContent = `📂 表示中：${view.name}`;
  document.body.classList.add('reviewing');
  history.pushState({ review: 1 }, '');        // 端末の「戻る」で見返しを終了
  applyLayout();
}
function closeReview() {
  view = null;
  document.body.classList.remove('reviewing');
  applyLayout();
}
$('btnExitReview').onclick = () => history.state && history.state.review ? history.back() : closeReview();
addEventListener('popstate', () => { if (view) closeReview(); });

// 全体グラフをタップ／なぞって地点を選ぶ
const cvA = $('cAll');
function scrub(e) {
  const g = cvA._geo;
  if (!view || !g) return;
  const rt = g.x0 + (e.clientX - cvA.getBoundingClientRect().left - g.l) / g.w * g.span;
  const RT = view.R.RT;
  let i = Math.min(RT.length - 1, lowerBound(RT, rt));
  if (i > 0 && Math.abs(RT[i - 1] - rt) <= Math.abs(RT[i] - rt)) i--;
  if (i !== view.ci) { view.ci = i; renderNow(); }
}
cvA.addEventListener('pointerdown', e => { if (view) { cvA.setPointerCapture(e.pointerId); scrub(e); } });
cvA.addEventListener('pointermove', e => { if (view && e.buttons) scrub(e); });

// ===================== デモ走行（10倍速のダミーデータ） =====================
function makeDemo() {
  let i = 0, v = 0, a = 120, lat = 43.80, t = Date.now(), seed = 7;
  const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  const L = 5400;                                   // 90分で1周（市街地→高速→山道→市街地）
  return () => {
    const p = (i % L) / L;
    let tgt = p < .2 ? 45 : p < .45 ? 95 : p < .75 ? 50 : 40;
    if (p < .2 && (i % 600) < 50) tgt = 0;
    if (p > .75 && (i % 500) < 40) tgt = 0;
    v = Math.max(0, v + (tgt - v) * 0.02 + (rnd() - .5) * 2.4);
    const ta = 120 + (p > .45 && p < .75 ? Math.sin((p - .45) / .3 * Math.PI) * 650 : 0) + Math.sin(i / 300) * 15;
    a += (ta - a) * 0.03 + (rnd() - .5) * 1.5;
    lat += v / 3.6 / 111000; i++; t += 1000;
    return { demo: true, timestamp: t,
      coords: { latitude: lat, longitude: 143.89, speed: v / 3.6, altitude: a - S.altOffset,
                accuracy: 3 + rnd() * 9, altitudeAccuracy: 5 + rnd() * 10 } };
  };
}
function toggleDemo() {
  if (view) closeReview();
  if (demo) {
    clearInterval(demoTimer); demo = null; rec = false; muni.name = null; muni.lastQ = 0;
    resetSession(); liveV = null; warn = null;
  } else {
    if (unsaved() && !confirm('デモ走行を始めると、保存していない記録はリセットされます。よろしいですか？')) return;
    if (rec) stopRec();
    resetSession();
    demo = makeDemo(); muni.name = null; muni.lastQ = 0;
    rec = true;
    demoTimer = setInterval(() => onPosition(demo()), 100);
    $('settings').close();
  }
  updateRecBtn(); updateGpsStatus(); syncForm();
}

// ===================== 描画 =====================
// GPSの更新ごとには描かず、設定した間隔（0.5〜2秒）でまとめて描き直す（ちらつき防止）
let needRender = true, renderTimer = null, rq = false;
function requestRender() { needRender = true; }
function renderNow() {               // 設定変更・画面回転・ピンチ・なぞり操作は即反映
  needRender = false;
  if (rq) return;
  rq = true;
  requestAnimationFrame(() => { rq = false; render(); });
}
function startRenderLoop() {
  clearInterval(renderTimer);
  renderTimer = setInterval(() => { if (needRender) { needRender = false; render(); } }, S.refresh * 1000);
}

function setStat(id, num, unit) {
  $(id).innerHTML = num == null ? '--' : `${num}${unit ? `<small>${unit}</small>` : ''}`;
}

function render() {
  const R = view ? view.R : D;
  const has = R.V.length > 0;
  const ci = view ? view.ci : R.V.length - 1;

  // --- 速度表示 ---
  const est = !view && IMU.est ? IMU.est.v * 3.6 : null;   // トンネル内などの推定値
  const v = view ? R.V[ci] : est != null ? est : liveV;
  const w = view ? warnOf(v) : est != null ? null : warn;
  $('speed').textContent = v == null ? '--' : Math.round(v);
  updateGpsStatus();
  $('speedbox').classList.toggle('estimating', est != null);
  $('speedbox').classList.toggle('warn-fast', w === 'fast' && v != null);
  $('speedbox').classList.toggle('warn-slow', w === 'slow' && v != null);
  $('dTarget').textContent = S.target;
  $('dTol').textContent = S.tol;
  $('dDiff').textContent = v == null ? ''
    : est != null ? `　推定 ${fmtMS((Date.now() - IMU.est.since) / 1000)}${IMU.model ? '' : '（学習前のため速度を保持）'}`
    : `　差 ${v - S.target >= 0 ? '+' : ''}${Math.round(v - S.target)}`;

  // --- 速度バー（設定速度 ± barHalf の範囲を拡大） ---
  const lo = S.target - S.barHalf, span = S.barHalf * 2, hi = lo + span;
  const P = x => Math.max(0, Math.min(100, (x - lo) / span * 100));
  const fill = $('fill');
  if (v == null) fill.style.width = '0';
  else {
    const pv = P(v);
    fill.style.left = Math.min(50, pv) + '%';
    fill.style.width = Math.abs(pv - 50) + '%';
    fill.style.background = est != null ? '#8a94a8' : colorFor(v);
    fill.style.borderRadius = pv < 50 ? '8px 0 0 8px' : '0 8px 8px 0';
  }
  $('band').style.left = P(S.target - S.tol) + '%';
  $('band').style.width = (P(S.target + S.tol) - P(S.target - S.tol)) + '%';
  $('ovL').classList.toggle('on', v != null && v < lo);
  $('ovR').classList.toggle('on', v != null && v > hi);
  const marks = [lo];
  if (S.tol < S.barHalf) marks.push(S.target - S.tol);
  marks.push(S.target);
  if (S.tol < S.barHalf) marks.push(S.target + S.tol);
  marks.push(hi);
  $('barLbl').innerHTML = marks.map(x =>
    `<span class="${x === S.target ? 'c' : ''}" style="left:${P(x)}%">${x < 0 ? '' : x}</span>`).join('');

  // --- 統計（数字は大きく、単位は小さく） ---
  setStat('sMax', has ? Math.round(R.maxV) : null, 'km/h');
  setStat('sAvg', R.moving > 0 ? Math.round(R.dist / (R.moving / 3600)) : null, 'km/h');
  setStat('sDist', has ? fmtDist(R.dist) : null, 'km');
  setStat('sTime', has ? fmtTime(R.recTime) : null, '');
  const alt = view ? R.A[ci] : altS;
  const srcLbl = view ? (R.demFixed ? '地理院' : '') : altSrc === 'dem' ? '地理院' : altSrc === 'gps' ? 'GPS' : '';
  $('sAltLbl').innerHTML = (view ? 'この地点の標高' : '現在標高') + (srcLbl ? `<em class="src">${srcLbl}</em>` : '');
  setStat('sAlt', alt == null ? null : Math.round(alt), 'm');
  setStat('sGain', has ? Math.round(R.gain) : null, 'm');

  // --- グラフ ---
  const win = S.winMin * 60;
  const last = has ? R.RT[R.RT.length - 1] : 0;
  if (view) {
    const rt = R.RT[ci];
    $('recentTtl').textContent = `${hhmm(R.T[ci])} の前後 ${winLabel(win)}`;
    setMuniLabel(muniAtIndex(R, ci));
    $('allTtl').innerHTML = 'ドライブ全体<em>なぞって地点を選択</em>';
    drawChart($('cRecent'), R, rt - win / 2, rt + win / 2, { win, cursor: rt });
    drawChart(cvA, R, 0, Math.max(last, 60), { small: true, cursor: rt, cursorLabel: hhmm(R.T[ci]) });
  } else {
    const x0 = Math.max(0, last - win);
    $('recentTtl').textContent = `直近 ${winLabel(win)}`;
    setMuniLabel(muni.name);
    $('allTtl').textContent = 'ドライブ全体';
    drawChart($('cRecent'), R, x0, x0 + win, { win, live: true });
    drawChart(cvA, R, 0, Math.max(last, 60), { small: true, win, frame: true });
  }
}

function setMuniLabel(name) {
  $('muni').textContent = name ? `📍 ${name}` : '';
  $('muni').hidden = !name;
}

function prep(cv) {
  const r = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  const W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height));
  const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  return { ctx, W, H };
}
function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
function niceStep(x) {
  const p = 10 ** Math.floor(Math.log10(x)), m = x / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

// src: 描くデータ, x0〜x1: 記録時間[s]の範囲
// o: { small, win, live（現在点を表示）, frame（直近の範囲枠）, cursor（見返しの位置）, cursorLabel }
function drawChart(cv, src, x0, x1, o) {
  const { ctx, W, H } = prep(cv);
  const bounds = o.small && src.M && src.M.length ? src.M : null;   // 市町村の境目
  const pad = { l: 30, r: 40, t: 26, b: o.small ? (bounds ? 16 : 6) : 16 };   // 上26pxはタイトル行
  const w = W - pad.l - pad.r, h = H - pad.t - pad.b;
  if (w < 20 || h < 20) return;
  const span = Math.max(1, x1 - x0);
  const X = rt => pad.l + (rt - x0) / span * w;
  cv._geo = { l: pad.l, w, x0, span };

  // 横1ピクセルごとにまとめて間引き（長時間でも軽く描ける）
  const pts = [];
  let cur = null;
  const fin = b => ({ x: b.x, v: b.sv / b.c, a: b.na ? b.sa / b.na : null, brk: b.brk });
  for (let i = lowerBound(src.RT, x0); i < src.RT.length && src.RT[i] <= x1; i++) {
    const x = X(src.RT[i]), px = Math.floor(x);
    if (!cur || px !== cur.px || src.B[i]) {
      if (cur) pts.push(fin(cur));
      cur = { px, x, sv: 0, c: 0, sa: 0, na: 0, brk: src.B[i] === 1 };
    }
    cur.sv += src.V[i]; cur.c++;
    if (src.A[i] != null) { cur.sa += src.A[i]; cur.na++; }
  }
  if (cur) pts.push(fin(cur));

  // 軸の範囲
  let vMax = scaleMax();
  for (const p of pts) if (p.v > vMax) vMax = p.v;
  vMax = Math.ceil(vMax / 20) * 20;
  let aLo = Infinity, aHi = -Infinity;
  for (const p of pts) if (p.a != null) { if (p.a < aLo) aLo = p.a; if (p.a > aHi) aHi = p.a; }
  if (aLo === Infinity) { aLo = 0; aHi = 100; }
  const aMid = (aLo + aHi) / 2, aSpan = Math.max(40, (aHi - aLo) * 1.15);
  const aStep = niceStep(aSpan / (o.small ? 2 : 4));
  aLo = Math.floor((aMid - aSpan / 2) / aStep) * aStep;
  aHi = Math.ceil((aMid + aSpan / 2) / aStep) * aStep;
  const Yv = v => pad.t + h - v / vMax * h;
  const Ya = a => pad.t + h - (a - aLo) / (aHi - aLo) * h;

  // 目盛り
  ctx.font = '10px system-ui, sans-serif'; ctx.lineWidth = 1;
  const vStep = niceStep(vMax / (o.small ? 2 : 4));
  ctx.strokeStyle = '#232c3d'; ctx.fillStyle = '#8a94a8'; ctx.textAlign = 'right';
  for (let v = 0; v <= vMax; v += vStep) {
    ctx.beginPath(); ctx.moveTo(pad.l, Yv(v)); ctx.lineTo(pad.l + w, Yv(v)); ctx.stroke();
    ctx.fillText(v, pad.l - 4, Yv(v) + 3);
  }
  ctx.fillStyle = ALT.label; ctx.textAlign = 'left';
  for (let a = aLo; a <= aHi + 1e-6; a += aStep) ctx.fillText(Math.round(a) + 'm', pad.l + w + 4, Ya(a) + 3);

  // 設定速度 ±許容幅 の帯（高度の面より上に描く）
  const drawBand = () => {
    ctx.fillStyle = '#ffffff14';
    ctx.fillRect(pad.l, Yv(Math.min(vMax, S.target + S.tol)), w,
      Yv(Math.max(0, S.target - S.tol)) - Yv(Math.min(vMax, S.target + S.tol)));
    ctx.strokeStyle = '#ffffff55'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pad.l, Yv(S.target)); ctx.lineTo(pad.l + w, Yv(S.target)); ctx.stroke();
    ctx.setLineDash([]);
  };

  if (!pts.length) {
    drawBand();
    ctx.fillStyle = '#8a94a8'; ctx.textAlign = 'center'; ctx.font = '13px system-ui, sans-serif';
    if (o.live) ctx.fillText('▶ を押すと記録を開始します', pad.l + w / 2, pad.t + h / 2);
    return;
  }

  // 高度（面＋線）
  const ap = pts.filter(p => p.a != null);
  if (ap.length > 1) {
    ctx.beginPath(); ctx.moveTo(ap[0].x, pad.t + h);
    for (const p of ap) ctx.lineTo(p.x, Ya(p.a));
    ctx.lineTo(ap[ap.length - 1].x, pad.t + h); ctx.closePath();
    const gr = ctx.createLinearGradient(0, pad.t, 0, pad.t + h);
    gr.addColorStop(0, ALT.fillTop); gr.addColorStop(1, ALT.fillBottom);
    ctx.fillStyle = gr; ctx.fill();
    ctx.strokeStyle = ALT.line; ctx.lineWidth = 2; ctx.beginPath();
    ap.forEach((p, k) => (k && !p.brk) ? ctx.lineTo(p.x, Ya(p.a)) : ctx.moveTo(p.x, Ya(p.a)));
    ctx.stroke();
  }

  drawBand();

  // 速度（設定との差で色分け、途切れはつながない）
  ctx.lineWidth = o.small ? 1.4 : 2.4; ctx.lineCap = 'round';
  for (let k = 1; k < pts.length; k++) {
    if (pts[k].brk) continue;
    ctx.strokeStyle = colorFor((pts[k - 1].v + pts[k].v) / 2);
    ctx.beginPath(); ctx.moveTo(pts[k - 1].x, Yv(pts[k - 1].v)); ctx.lineTo(pts[k].x, Yv(pts[k].v)); ctx.stroke();
  }

  ctx.font = '10px system-ui, sans-serif';
  if (o.small) {
    if (bounds) {           // 市町村の境目（点線）と名前
      ctx.font = 'bold 10px system-ui, sans-serif'; ctx.textAlign = 'left';
      let lastEnd = -Infinity;
      bounds.forEach((m, k) => {
        if (m.i >= src.RT.length) return;
        const bx = X(src.RT[m.i]);
        if (k) {
          ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(bx, pad.t); ctx.lineTo(bx, pad.t + h); ctx.stroke(); ctx.setLineDash([]);
        }
        const tx = Math.max(bx + 3, lastEnd + 6);                // 名前どうしが重ならないように
        if (tx < pad.l + w) {
          ctx.fillStyle = '#22d3ee'; ctx.fillText(m.n, tx, H - 3);
          lastEnd = tx + ctx.measureText(m.n).width;
        }
      });
      ctx.font = '10px system-ui, sans-serif';
    }
    if (o.frame) {          // 直近グラフの範囲を枠で表示
      const last = src.RT[src.RT.length - 1];
      const fx0 = X(Math.max(0, last - o.win)), fx1 = X(last);
      ctx.strokeStyle = '#ffffffaa'; ctx.lineWidth = 1;
      ctx.strokeRect(fx0, pad.t, Math.max(2, fx1 - fx0), h);
    }
    if (src.maxI >= 0) {    // 最高速度地点
      const mx = X(src.RT[src.maxI]), my = Yv(src.maxV);
      ctx.fillStyle = '#fbbf24'; ctx.beginPath(); ctx.arc(mx, my, 3.5, 0, 7); ctx.fill();
      ctx.textAlign = mx > pad.l + w - 60 ? 'right' : 'left';
      ctx.fillText('MAX ' + Math.round(src.maxV), mx + (ctx.textAlign === 'right' ? -6 : 6), Math.max(pad.t + 8, my - 4));
    }
  } else if (o.live) {
    const p = pts[pts.length - 1];
    ctx.fillStyle = colorFor(p.v); ctx.beginPath(); ctx.arc(p.x, Yv(p.v), 4.5, 0, 7); ctx.fill();
    ctx.fillStyle = '#8a94a8';
    ctx.textAlign = 'left'; ctx.fillText('-' + winLabel(o.win), pad.l, H - 3);
    ctx.textAlign = 'right'; ctx.fillText('現在', pad.l + w, H - 3);
  }

  if (o.cursor != null) {   // 見返しの位置（縦線＋時刻の吹き出し）
    const cx = X(o.cursor);
    ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, pad.t); ctx.lineTo(cx, pad.t + h); ctx.stroke();
    if (o.cursorLabel) {
      ctx.font = 'bold 11px system-ui, sans-serif';
      const tw = ctx.measureText(o.cursorLabel).width + 10;
      const bx = cx + 4 + tw > pad.l + w ? cx - 4 - tw : cx + 4;
      const by = pad.t + h - 18;          // 下端に置いて MAX 表示と重ならないように
      ctx.fillStyle = '#fbbf24'; ctx.fillRect(bx, by, tw, 16);
      ctx.fillStyle = '#140a2e'; ctx.textAlign = 'left'; ctx.fillText(o.cursorLabel, bx + 5, by + 12);
    }
  }
}

// ===================== 直近グラフの表示時間（ピンチ／ホイール） =====================
function setWin(min, commit) {
  min = Math.min(120, Math.max(0.5, min));
  if (commit) min = Math.round(min * 2) / 2;
  S.winMin = min;
  if (commit) saveSettings();
  renderNow();
}
const cvR = $('cRecent');
const tdist = ts => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
let pinch = null;
cvR.addEventListener('touchstart', e => {
  if (e.touches.length === 2) { pinch = { d: tdist(e.touches), w: S.winMin }; e.preventDefault(); }
}, { passive: false });
cvR.addEventListener('touchmove', e => {
  if (pinch && e.touches.length === 2) { e.preventDefault(); setWin(pinch.w * pinch.d / tdist(e.touches), false); }
}, { passive: false });
cvR.addEventListener('touchend', e => {
  if (pinch && e.touches.length < 2) { pinch = null; setWin(S.winMin, true); }
});
cvR.addEventListener('wheel', e => {
  e.preventDefault(); setWin(S.winMin * (e.deltaY > 0 ? 1.25 : 0.8), true);
}, { passive: false });

// ===================== レイアウト（縦／横） =====================
function applyLayout() {
  const mode = S.layout === 'auto' ? (innerHeight > innerWidth ? 'portrait' : 'landscape') : S.layout;
  app.classList.toggle('portrait', mode === 'portrait');
  app.classList.toggle('landscape', mode === 'landscape');
  renderNow();
}
function lockOrientation() {
  const so = screen.orientation;
  if (!so) return;
  if (S.layout === 'auto') { try { so.unlock(); } catch {} }
  else if (so.lock) so.lock(S.layout).catch(() => {});   // インストール済み（全画面）なら固定される
}
addEventListener('resize', applyLayout);

// ===================== 設定ダイアログ =====================
const dlg = $('settings');
const FIELDS = { fTarget: 'target', fTol: 'tol', fBar: 'barHalf', fWin: 'winMin', fAltOff: 'altOffset', fRefresh: 'refresh' };

function syncForm() {
  for (const [id, key] of Object.entries(FIELDS)) $(id).value = S[key];
  $('fLayout').value = S.layout;
  $('fBeep').checked = S.beep;
  $('fMuniSound').checked = S.muniSound;
  document.querySelectorAll('.chips').forEach(ch => {
    const v = +$(ch.dataset.for).value;
    ch.querySelectorAll('button').forEach(b => b.classList.toggle('sel', +b.textContent === v));
  });
  $('btnDemo').textContent = demo ? 'デモ走行を終了' : 'デモ走行を開始';
  const imu = !IMU.events ? '加速度センサー：未検出'
    : IMU.model ? `加速度センサー：学習済み（相関 ${IMU.model.corr.toFixed(2)}・GPSの遅れ ${IMU.model.lag}秒）`
    : `加速度センサー：学習中（データ ${Math.min(IMU.fit.n, IMU_MIN_PAIRS)}/${IMU_MIN_PAIRS}・相関 ${IMU.fit.corr.toFixed(2)}）`;
  $('info').textContent = `記録点数 ${D.V.length}　/　データ量 約${Math.round(JSON.stringify(D).length / 1024)}KB　/　${imu}`;
}
function onField(id) {
  const key = FIELDS[id], v = parseFloat($(id).value);
  if (isNaN(v)) return;
  if (key === 'winMin') S.winMin = Math.min(120, Math.max(0.5, v));
  else if (key === 'refresh') { S.refresh = Math.min(5, Math.max(0.2, v)); startRenderLoop(); }
  else if (key === 'tol') S.tol = Math.max(1, v);
  else if (key === 'target') S.target = Math.min(200, Math.max(10, v));
  else if (key === 'barHalf') S.barHalf = Math.min(100, Math.max(5, v));
  else S[key] = v;
  saveSettings(); syncForm(); renderNow();
}
for (const id of Object.keys(FIELDS)) $(id).addEventListener('change', () => onField(id));
document.querySelectorAll('.chips').forEach(ch => {
  for (const val of ch.dataset.values.split(',')) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = val;
    b.onclick = () => { $(ch.dataset.for).value = val; onField(ch.dataset.for); };
    ch.appendChild(b);
  }
});
$('fLayout').onchange = e => { S.layout = e.target.value; saveSettings(); applyLayout(); lockOrientation(); };
$('fBeep').onchange = e => { S.beep = e.target.checked; saveSettings(); if (S.beep) { ensureAudio(); beep(true); } };
$('btnSettings').onclick = () => {
  syncForm(); dlg.showModal();
  document.activeElement?.blur();   // 開いた瞬間にキーボードが出ないように
};
$('fMuniSound').onchange = e => { S.muniSound = e.target.checked; saveSettings(); if (S.muniSound) { ensureAudio(); chime(); } };
$('btnDemo').onclick = toggleDemo;
$('btnReset').onclick = () => {
  if (demo) { toggleDemo(); return; }
  const msg = unsaved() ? '保存していない記録は消えます。記録をリセットして新しいドライブを始めますか？'
                        : '記録をリセットして新しいドライブを始めます。よろしいですか？';
  if (!confirm(msg)) return;
  resetSession(); syncForm();
};

// ===================== 起動 =====================
startRenderLoop();
applyLayout();
updateRecBtn();
try { if (localStorage.getItem('drv.rec') === '1') startRec(); } catch {}   // 記録中に閉じた／再読み込みした
// すでに位置情報が許可されていれば、記録前から速度を表示
navigator.permissions?.query({ name: 'geolocation' }).then(p => { if (p.state === 'granted') startGps(); }).catch(() => {});
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
