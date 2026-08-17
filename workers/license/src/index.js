/**
 * Wordlyte license server — Cloudflare Worker.
 *
 * Endpoints
 * ---------
 *   POST /validate   Called by the desktop app (Rust `license.rs`). Body:
 *                    { license_key, machine_id, app_name, app_version }.
 *                    Registers a machine against a key (up to `max_machines`)
 *                    and returns authoritative status/expiry/server time.
 *
 *   POST /issue      Admin only. Bearer token. Issues a new key:
 *                    { church_name, email, duration_days, max_machines, tier, note }
 *                    tier is free|pro|premium (default free) and clamps
 *                    max_machines (free=1, pro=3, premium=50).
 *
 *   POST /extend     Admin only. { license_key, days?, tier? } — add days
 *                    and/or change tier (upgrades + clamps max_machines).
 *
 *   POST /revoke     Admin only. { license_key, revoked?: bool }
 *
 *   GET  /licenses   Admin only. Lists every issued key + machine slots.
 *
 * The app talks to /validate from the Rust backend (reqwest), never from the
 * webview, so there is no CORS concern for the desktop app itself.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      });

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, GET, OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
        },
      });
    }

    // ── Admin web UI (page is public; every action on it needs the token) ──
    if (path === "/admin") {
      return new Response(ADMIN_HTML, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      });
    }

    if (!env.LICENSES) {
      return json(
        {
          status: "error",
          message:
            "KV binding 'LICENSES' is not attached to this worker. Add it in Settings → Variables → KV namespace bindings (variable name must be LICENSES).",
        },
        500
      );
    }

    const now = () => Math.floor(Date.now() / 1000);

    const tierOf = (rec) => TIERS.includes(rec.tier) ? rec.tier : "free";

    // ── /validate ─────────────────────────────────────────────────────────
    if (path === "/validate" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ status: "invalid", message: "Bad request" }, 400);
      }

      const key = String(body.license_key || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");
      const machineId = String(body.machine_id || "").trim();
      if (!key) return json({ status: "invalid", message: "Missing license key" }, 400);
      if (!/^[0-9a-f]{64}$/i.test(machineId))
        return json({ status: "invalid", message: "Missing or malformed machine id" }, 400);

      const rec = await env.LICENSES.get(key, "json");
      const serverTime = now();
      if (!rec)
        return json({
          status: "invalid",
          message: "Unknown license key. Check the key or contact the Wordlyte team.",
        });

      const common = () => ({
        expires_at: rec.expires_at,
        issued_at: rec.issued_at,
        church_name: rec.church_name,
        email: rec.email,
        tier: tierOf(rec),
        max_machines: rec.max_machines,
        machines_used: (rec.machines || []).length,
        server_time: serverTime,
      });

      if (rec.revoked)
        return json({
          status: "revoked",
          message: "This license has been revoked by the administrator.",
          ...common(),
        });

      if (serverTime >= rec.expires_at)
        return json({
          status: "expired",
          message: "This license has expired.",
          ...common(),
        });

      let machines = rec.machines || [];
      if (!machines.includes(machineId)) {
        if (machines.length >= rec.max_machines) {
          return json({
            status: "invalid",
            message: `This key is already activated on ${machines.length} device(s) (limit ${rec.max_machines}). Contact the Wordlyte team to add more.`,
            ...common(),
          });
        }
        machines.push(machineId);
        rec.machines = machines;
        await env.LICENSES.put(key, JSON.stringify(rec));
      }

      return json({ status: "active", message: "ok", ...common() });
    }

    // ── Admin (Authorization: Bearer <ADMIN_TOKEN>) ────────────────────────
    const isAdmin = () => {
      const header = request.headers.get("authorization") || "";
      const token = header.replace(/^Bearer\s+/i, "");
      return token.length > 0 && token === env.ADMIN_TOKEN;
    };

    if (path === "/issue" && request.method === "POST") {
      if (!isAdmin()) return json({ status: "error", message: "Unauthorized" }, 401);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ status: "error", message: "Bad request" }, 400);
      }
      const church = String(body.church_name || "").trim();
      const email = String(body.email || "").trim().toLowerCase();
      const days = Math.max(1, Math.min(3650, parseInt(body.duration_days, 10) || 30));
      const tier = normalizeTier(body.tier);
      const maxMachines = clampMachines(tier, body.max_machines);
      if (!church) return json({ status: "error", message: "church_name is required" }, 400);

      const key = generateKey();
      const issuedAt = now();
      const rec = {
        key,
        church_name: church,
        email,
        issued_at: issuedAt,
        expires_at: issuedAt + days * 86400,
        tier,
        max_machines: maxMachines,
        machines: [],
        revoked: false,
        note: String(body.note || ""),
        created_at: issuedAt,
      };
      await env.LICENSES.put(key, JSON.stringify(rec));
      return json({ status: "ok", license_key: key, ...rec });
    }

    if (path === "/revoke" && request.method === "POST") {
      if (!isAdmin()) return json({ status: "error", message: "Unauthorized" }, 401);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ status: "error", message: "Bad request" }, 400);
      }
      const key = String(body.license_key || "").trim().toUpperCase();
      const rec = await env.LICENSES.get(key, "json");
      if (!rec) return json({ status: "error", message: "Unknown license key" }, 404);
      rec.revoked = body.revoked !== false;
      await env.LICENSES.put(key, JSON.stringify(rec));
      return json({ status: "ok", ...rec });
    }

    if (path === "/extend" && request.method === "POST") {
      if (!isAdmin()) return json({ status: "error", message: "Unauthorized" }, 401);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ status: "error", message: "Bad request" }, 400);
      }
      const key = String(body.license_key || "").trim().toUpperCase();
      const days = Math.max(0, Math.min(3650, parseInt(body.days, 10) || 0));
      const tier = body.tier !== undefined ? normalizeTier(body.tier) : null;
      const rec = await env.LICENSES.get(key, "json");
      if (!rec) return json({ status: "error", message: "Unknown license key" }, 404);
      if (days <= 0 && !tier)
        return json({ status: "error", message: "Provide days and/or a tier" }, 400);
      if (days > 0) rec.expires_at = Math.max(now(), rec.expires_at) + days * 86400;
      if (tier) {
        rec.tier = tier;
        rec.max_machines = clampMachines(tier, rec.max_machines);
      }
      await env.LICENSES.put(key, JSON.stringify(rec));
      return json({ status: "ok", ...rec });
    }

    if (path === "/licenses" && request.method === "GET") {
      if (!isAdmin()) return json({ status: "error", message: "Unauthorized" }, 401);
      return json({ status: "ok", licenses: await collectLicenses(env) });
    }

    if (path === "/expiring" && request.method === "GET") {
      if (!isAdmin()) return json({ status: "error", message: "Unauthorized" }, 401);
      const days = Math.max(0, Math.min(365, parseInt(url.searchParams.get("days"), 10) || 30));
      const nowSec = now();
      const cutoff = nowSec + days * 86400;
      const expiring = (await collectLicenses(env))
        .filter((l) => !l.revoked && l.expires_at < cutoff)
        .map((l) => ({
          key: l.key,
          church_name: l.church_name,
          email: l.email,
          tier: tierOf(l),
          expires_at: l.expires_at,
          machines_used: (l.machines || []).length,
        }));
      return json({ status: "ok", within_days: days, server_time: nowSec, expiring });
    }

    return json({ status: "error", message: "Not found" }, 404);
  },

  // Daily cron (see [triggers] in wrangler.toml): report licenses expiring soon.
  // Post to a Slack/Discord/Teams webhook if EXPIRY_WEBHOOK_URL is set, else log.
  async scheduled(event, env, ctx) {
    if (!env.LICENSES) return;
    const days = parseInt(env.EXPIRY_NOTIFY_DAYS || "14", 10);
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoff = nowSec + days * 86400;
    const all = await collectLicenses(env);
    const expiring = all.filter((l) => !l.revoked && l.expires_at > nowSec && l.expires_at < cutoff);
    const expired = all.filter((l) => !l.revoked && l.expires_at <= nowSec);

    const webhook = env.EXPIRY_WEBHOOK_URL;
    if (!webhook) {
      console.log(
        `[scheduled] ${expiring.length} expiring within ${days}d, ${expired.length} expired (no webhook configured)`
      );
      return;
    }

    const line = (l) =>
      `• ${l.church_name} (${l.email}) — ${new Date(l.expires_at * 1000).toISOString().slice(0, 10)}`;
    const text = [
      `License reminders (within ${days}d):`,
      ...expiring.map(line),
      ...(expired.length ? [`Expired:`] : []),
      ...expired.map(line),
    ].join("\n");
    await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  },
};

async function collectLicenses(env) {
  const licenses = [];
  let cursor;
  let page;
  do {
    page = await env.LICENSES.list({ cursor });
    for (const { name } of page.keys) {
      const rec = await env.LICENSES.get(name, "json");
      if (rec) licenses.push({ key: name, ...rec });
    }
    cursor = page.cursor;
  } while (!page.list_complete);
  return licenses;
}

function generateKey() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
  const seg = (n) =>
    Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  return `WORDLYTE-${seg(4)}-${seg(4)}-${seg(4)}-${seg(4)}`;
}

const TIERS = ["free", "pro", "premium"];
const TIER_MAX_MACHINES = { free: 1, pro: 3, premium: 50 };

function normalizeTier(v) {
  const t = String(v || "").trim().toLowerCase();
  return TIERS.includes(t) ? t : "free";
}

function clampMachines(tier, requested) {
  const cap = TIER_MAX_MACHINES[normalizeTier(tier)] || 50;
  const n = Math.max(1, Math.min(50, parseInt(requested, 10) || 1));
  return Math.min(n, cap);
}

const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wordlyte License Admin</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--border:#2a2f3a;--text:#e6e8ee;--muted:#9aa1ae;--accent:#f59e0b;--green:#34d399;--red:#f87171}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text)}
header{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--border)}
header h1{font-size:16px;margin:0}header .spacer{flex:1}main{max-width:1100px;margin:20px auto;padding:0 20px;display:grid;gap:16px}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input,select,button{font:inherit}input,select,textarea{background:#0d0f13;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:7px 9px}
button{background:#232838;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:7px 12px;cursor:pointer}button:hover{border-color:var(--accent)}
button.primary{background:var(--accent);color:#0f1115;font-weight:600}button.danger{color:var(--red)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)}
th{color:var(--muted);font-weight:500}.badge{padding:2px 8px;border-radius:999px;font-size:11px}.badge.active{background:#0f2e24;color:var(--green)}.badge.revoked{background:#3a1418;color:var(--red)}.badge.expired{background:#3a2c10;color:var(--accent)}
.stats{display:flex;gap:24px}.stat b{font-size:22px;display:block}.muted{color:var(--muted)}.error{color:var(--red)}
#login{max-width:400px;margin:80px auto}.hidden{display:none}.key{font-family:ui-monospace,monospace}.toast{position:fixed;bottom:16px;right:16px;background:#232838;border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:13px;z-index:9}
</style>
</head>
<body>
<div id="login" class="panel">
  <h1>Wordlyte License Admin</h1>
  <p class="muted">Enter the admin token to manage license keys.</p>
  <div class="row">
    <input id="tokenInput" type="password" placeholder="ADMIN_TOKEN" style="flex:1">
    <button class="primary" onclick="login()">Sign in</button>
  </div>
  <p id="loginError" class="error"></p>
</div>

<div id="app" class="hidden">
  <header>
    <h1>Wordlyte License Admin</h1>
    <span class="muted" id="statusDot"></span>
    <div class="spacer"></div>
    <button onclick="load()">Refresh</button>
    <button onclick="logout()">Sign out</button>
  </header>
  <main>
    <div class="panel stats" id="stats"></div>
      <div class="panel">
      <h3>Issue a key</h3>
      <div class="row">
        <input id="fChurch" placeholder="Church name" style="flex:2">
        <input id="fEmail" placeholder="Email" style="flex:2">
        <input id="fDays" type="number" value="90" title="days" style="width:80px">
        <input id="fMachines" type="number" value="3" title="machines" style="width:80px">
        <select id="fTier" title="tier" style="width:100px">
          <option value="free">Free</option>
          <option value="pro" selected>Pro</option>
          <option value="premium">Premium</option>
        </select>
        <button class="primary" onclick="issue()">Issue</button>
      </div>
    </div>
    <div class="panel">
      <h3>Bulk issue (CSV: church_name,email,duration_days,max_machines,tier)</h3>
      <textarea id="fCsv" rows="4" placeholder="First Baptist Church,pastor@fbc.org,90,3" style="width:100%"></textarea>
      <div class="row" style="margin-top:8px"><button onclick="bulkIssue()">Issue all rows</button><span class="muted" id="bulkResult"></span></div>
    </div>
    <div class="panel">
      <div class="row">
        <h3 style="margin:0">Licenses</h3>
        <div class="spacer"></div>
        <label class="muted" style="font-size:13px">Show expiring within
          <input id="fExpiring" type="number" value="30" style="width:64px" onchange="load()"> days
        </label>
      </div>
<table>
          <thead><tr><th>Key</th><th>Church</th><th>Email</th><th>Expires</th><th>Machines</th><th>Tier</th><th>Status</th><th></th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
    </div>
  </main>
</div>
<div id="toast" class="toast hidden"></div>

<script>
var token = sessionStorage.getItem("admin_token");
var licenses = [];

function esc(s){return String(s == null ? "" : s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function toast(msg, isError){var t=document.getElementById("toast");t.textContent=msg;t.className="toast"+(isError?" error":"");setTimeout(function(){t.className="toast hidden";},3000);}
async function api(path, opts){opts=opts||{};opts.headers=opts.headers||{};opts.headers["content-type"]="application/json";opts.headers.authorization="Bearer "+token;var res=await fetch(path,opts);var data=await res.json().catch(function(){return null;});return {status:res.status,data:data};}
function fmt(ts){return new Date(ts*1000).toISOString().slice(0,10);}
function statusBadge(l){var now=Math.floor(Date.now()/1000);if(l.revoked)return '<span class="badge revoked">revoked</span>';if(now>=l.expires_at)return '<span class="badge expired">expired</span>';return '<span class="badge active">active</span>';}
function tierBadge(l){var t=l.tier||"free";var c=t==="premium"?"#a78bfa":t==="pro"?"#38bdf8":"#9aa1ae";return '<span class="badge" style="color:'+c+';border:1px solid '+c+'">'+esc(t)+'</span>';}

function login(){token=document.getElementById("tokenInput").value.trim();if(!token)return;sessionStorage.setItem("admin_token",token);showApp();}
function logout(){token="";sessionStorage.removeItem("admin_token");document.getElementById("login").classList.remove("hidden");document.getElementById("app").classList.add("hidden");}
async function showApp(){document.getElementById("login").classList.add("hidden");document.getElementById("app").classList.remove("hidden");await load();}

async function load(){
  var r=await api("/licenses");
  if(r.status===401){toast("Unauthorized — check the token",true);return;}
  if(!r.data||r.data.status!=="ok"){toast("Failed to load licenses",true);return;}
  licenses=r.data.licenses;
  var now=Math.floor(Date.now()/1000);
  var days=parseInt(document.getElementById("fExpiring").value,10)||30;
  var cutoff=now+days*86400;
  var active=licenses.filter(function(l){return !l.revoked&&l.expires_at>now;}).length;
  var revoked=licenses.filter(function(l){return l.revoked;}).length;
  var expiring=licenses.filter(function(l){return !l.revoked&&l.expires_at<cutoff;}).length;
  document.getElementById("statusDot").textContent=licenses.length+" key(s)";
  document.getElementById("stats").innerHTML=
    '<div class="stat"><b>'+licenses.length+'</b>total</div>'+
    '<div class="stat"><b>'+active+'</b>active</div>'+
    '<div class="stat"><b>'+revoked+'</b>revoked</div>'+
    '<div class="stat"><b>'+expiring+'</b>expiring ≤ '+days+'d</div>';
  renderRows();
}

function renderRows(){
  var days=parseInt(document.getElementById("fExpiring").value,10)||30;
  var cutoff=Math.floor(Date.now()/1000)+days*86400;
  var list=licenses.slice().sort(function(a,b){return a.expires_at-b.expires_at;});
  var tbody=document.getElementById("rows");
  if(list.length===0){tbody.innerHTML='<tr><td colspan="8" class="muted">No licenses yet.</td></tr>';return;}
  tbody.innerHTML=list.map(function(l){
    var soon=l.expires_at<cutoff?' <span class="badge active">soon</span>':'';
    var used=(l.machines||[]).length;
    return '<tr>'+
      '<td class="key">'+esc(l.key)+' <button data-action="copy" data-key="'+esc(l.key)+'" title="copy">copy</button></td>'+
      '<td>'+esc(l.church_name)+'</td>'+
      '<td>'+esc(l.email)+'</td>'+
      '<td>'+fmt(l.expires_at)+soon+'</td>'+
      '<td>'+used+'/'+l.max_machines+'</td>'+
      '<td>'+tierBadge(l)+'</td>'+
      '<td>'+statusBadge(l)+'</td>'+
      '<td><button data-action="extend" data-key="'+esc(l.key)+'">Extend</button> <button data-action="tier" data-key="'+esc(l.key)+'">Tier</button> <button class="danger" data-action="revoke" data-key="'+esc(l.key)+'">'+(l.revoked?'Restore':'Revoke')+'</button></td>'+
    '</tr>';
  }).join("");
}

async function issue(){
  var church=document.getElementById("fChurch").value.trim();
  var email=document.getElementById("fEmail").value.trim();
  if(!church||!email){toast("Church name and email required",true);return;}
  var r=await api("/issue",{method:"POST",body:JSON.stringify({church_name:church,email:email,duration_days:parseInt(document.getElementById("fDays").value,10)||90,max_machines:parseInt(document.getElementById("fMachines").value,10)||3,tier:document.getElementById("fTier").value,note:"ui"})});
  if(r.data&&r.data.status==="ok"){toast("Issued "+r.data.license_key);document.getElementById("fChurch").value="";document.getElementById("fEmail").value="";await load();}
  else toast("Issue failed: "+(r.data&&r.data.message||r.status),true);
}

async function bulkIssue(){
  var lines=document.getElementById("fCsv").value.split(/\\r?\\n/).map(function(s){return s.trim();}).filter(Boolean).filter(function(s){return !/^church/i.test(s);});
  var ok=0,fail=0,out=[];
  for(var i=0;i<lines.length;i++){
    var parts=lines[i].split(",").map(function(s){return s.trim();});
    var r=await api("/issue",{method:"POST",body:JSON.stringify({church_name:parts[0],email:parts[1],duration_days:parseInt(parts[2],10)||90,max_machines:parts[3]?parseInt(parts[3],10):3,tier:parts[4]||"pro",note:"bulk-ui"})});
    if(r.data&&r.data.status==="ok"){ok++;out.push(r.data.license_key);}else{fail++;out.push("FAIL "+parts[0]);}
  }
  document.getElementById("bulkResult").textContent=ok+" issued, "+fail+" failed";
  document.getElementById("fCsv").value=out.join("\\n");
  await load();
}

async function extend(key){var days=window.prompt("Extend "+key+" by how many days?","14");if(!days)return;var r=await api("/extend",{method:"POST",body:JSON.stringify({license_key:key,days:parseInt(days,10)})});if(r.data&&r.data.status==="ok"){toast("Extended to "+fmt(r.data.expires_at));await load();}else toast("Extend failed",true);}
async function changeTier(key){var l=licenses.find(function(x){return x.key===key;});var cur=l.tier||"free";var tier=window.prompt("Tier for "+key+" (free/pro/premium) — current: "+cur,cur);if(!tier)return;var r=await api("/extend",{method:"POST",body:JSON.stringify({license_key:key,tier:tier})});if(r.data&&r.data.status==="ok"){toast("Tier set to "+r.data.tier+" (max "+r.data.max_machines+" machines)");await load();}else toast("Tier change failed",true);}
async function toggleRevoke(key){var l=licenses.find(function(x){return x.key===key;});var want=!l.revoked;if(want&&!window.confirm("Revoke "+key+"?"))return;var r=await api("/revoke",{method:"POST",body:JSON.stringify({license_key:key,revoked:want})});if(r.data&&r.data.status==="ok"){toast((want?"Revoked":"Restored")+" "+key);await load();}else toast("Revoke failed",true);}
function copyKey(key){navigator.clipboard&&navigator.clipboard.writeText(key).then(function(){toast("Copied "+key);});}

document.getElementById("rows").addEventListener("click",function(e){
  var btn=e.target.closest("button[data-action]");
  if(!btn)return;
  var key=btn.dataset.key, action=btn.dataset.action;
  if(action==="copy")copyKey(key);
  else if(action==="extend")extend(key);
  else if(action==="tier")changeTier(key);
  else if(action==="revoke")toggleRevoke(key);
});

if(token){document.getElementById("tokenInput").value=token;showApp();}
</script>
</body>
</html>`;