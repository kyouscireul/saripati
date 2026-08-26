/**
 * The SARIPATI dashboard, embedded as a single self-contained HTML document so
 * it ships as a string (no build step) in both the npm package and the single
 * binary. Client JS uses string concatenation (no template literals) so it nests
 * cleanly inside this TS template literal.
 */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SARIPATI — Knowledge Vault</title>
<style>
  :root {
    --bg: #0a0a0f; --panel: #14141c; --panel2: #1c1c26; --line: #2a2a38;
    --text: #e8e8f0; --dim: #9a9ab0; --accent: #f59e0b; --accent2: #f97316;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 "DM Sans", -apple-system, Segoe UI, Roboto, sans-serif; }
  header { padding: 20px 28px; border-bottom: 1px solid var(--line);
    display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 22px; letter-spacing: 0.5px;
    background: linear-gradient(90deg, var(--accent), var(--accent2));
    -webkit-background-clip: text; background-clip: text; color: transparent; }
  .sub { color: var(--dim); font-size: 13px; }
  .stats { margin-left: auto; display: flex; gap: 22px; }
  .stat b { font-size: 20px; } .stat span { color: var(--dim); font-size: 12px; display: block; }
  main { display: grid; grid-template-columns: 340px 1fr; gap: 0; height: calc(100vh - 74px); }
  .left { border-right: 1px solid var(--line); overflow-y: auto; padding: 18px; }
  .right { overflow-y: auto; padding: 26px 32px; }
  .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1px;
    color: var(--dim); margin: 18px 0 8px; }
  input[type=search] { width: 100%; padding: 10px 12px; background: var(--panel);
    border: 1px solid var(--line); border-radius: 8px; color: var(--text); font-size: 14px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px;
    background: var(--panel); color: var(--dim); font-size: 12px; cursor: pointer; }
  .chip:hover { color: var(--text); border-color: var(--accent); }
  .chip.on { background: linear-gradient(90deg, var(--accent), var(--accent2));
    color: #1a1200; border-color: transparent; font-weight: 600; }
  .bars { display: flex; align-items: flex-end; gap: 3px; height: 46px; margin-top: 6px; }
  .bar { flex: 1; background: linear-gradient(180deg, var(--accent), var(--accent2));
    border-radius: 2px 2px 0 0; min-height: 2px; opacity: 0.85; }
  .list { margin-top: 8px; }
  .item { padding: 12px; border: 1px solid var(--line); border-radius: 10px;
    margin-bottom: 8px; cursor: pointer; background: var(--panel); }
  .item:hover { border-color: var(--accent); }
  .item.on { border-color: var(--accent); background: var(--panel2); }
  .item .t { font-weight: 600; margin-bottom: 4px; }
  .item .m { color: var(--dim); font-size: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
  .badge { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
    padding: 2px 7px; border-radius: 5px; background: var(--panel2); color: var(--accent); }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; }
  .btn { padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--panel); color: var(--text); cursor: pointer; font-size: 13px; }
  .btn.primary { background: linear-gradient(90deg, var(--accent), var(--accent2));
    color: #1a1200; border: none; font-weight: 600; }
  .detail h2 { margin: 0 0 6px; font-size: 20px; }
  .detail .meta { color: var(--dim); font-size: 13px; margin-bottom: 18px; }
  .detail .body { white-space: pre-wrap; background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 16px; }
  .sources { margin-top: 18px; }
  .source { padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px;
    margin-bottom: 8px; background: var(--panel); }
  .source a { color: var(--accent); text-decoration: none; }
  .empty { color: var(--dim); padding: 40px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>SARIPATI</h1>
  <span class="sub">the essence of what you know</span>
  <div class="stats" id="stats"></div>
</header>
<main>
  <div class="left">
    <input type="search" id="q" placeholder="Search the vault (keyword)…" />
    <div class="section-title">Kinds</div>
    <div class="chips" id="kinds"></div>
    <div class="section-title">Top topics</div>
    <div class="chips" id="tags"></div>
    <div class="section-title">Activity (last 30 days)</div>
    <div class="bars" id="bars"></div>
    <div class="section-title">Entries</div>
    <div class="list" id="list"></div>
  </div>
  <div class="right" id="right">
    <div class="empty">Select an entry to view it.</div>
  </div>
</main>
<script>
var state = { q: "", kind: "", entries: [], selected: null };

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function api(path) { return fetch(path).then(function (r) { return r.json(); }); }

function loadStatus() {
  api("/api/status").then(function (s) {
    document.getElementById("stats").innerHTML =
      '<div class="stat"><b>' + s.total + '</b><span>entries</span></div>' +
      '<div class="stat"><b>' + s.projects + '</b><span>projects</span></div>' +
      '<div class="stat"><b>' + s.sessions + '</b><span>sessions</span></div>' +
      '<div class="stat"><b>' + esc((s.lastUpdated || "—").slice(0, 10)) + '</b><span>updated</span></div>';

    var kinds = ["research", "note", "decision", "pattern"];
    document.getElementById("kinds").innerHTML = kinds.map(function (k) {
      var n = s.byKind[k] || 0;
      return '<span class="chip" data-kind="' + k + '">' + k + " (" + n + ")</span>";
    }).join("");
    Array.prototype.forEach.call(document.querySelectorAll("#kinds .chip"), function (el) {
      el.onclick = function () {
        var k = el.getAttribute("data-kind");
        state.kind = state.kind === k ? "" : k;
        renderKindChips(); loadEntries();
      };
    });

    document.getElementById("tags").innerHTML = (s.topTags || []).map(function (t) {
      return '<span class="chip" data-tag="' + esc(t.tag) + '">' + esc(t.tag) + " (" + t.count + ")</span>";
    }).join("") || '<span class="sub">no tags yet</span>';
    Array.prototype.forEach.call(document.querySelectorAll("#tags .chip"), function (el) {
      el.onclick = function () {
        document.getElementById("q").value = el.getAttribute("data-tag");
        state.q = el.getAttribute("data-tag"); loadEntries();
      };
    });

    var tl = (s.timeline || []).slice().reverse();
    var max = Math.max(1, Math.max.apply(null, tl.map(function (d) { return d.count; }).concat([1])));
    document.getElementById("bars").innerHTML = tl.map(function (d) {
      return '<div class="bar" title="' + esc(d.day) + ": " + d.count +
        '" style="height:' + Math.round((d.count / max) * 100) + '%"></div>';
    }).join("");
  });
}

function renderKindChips() {
  Array.prototype.forEach.call(document.querySelectorAll("#kinds .chip"), function (el) {
    if (el.getAttribute("data-kind") === state.kind) el.classList.add("on");
    else el.classList.remove("on");
  });
}

function loadEntries() {
  var p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (state.kind) p.set("kind", state.kind);
  api("/api/entries?" + p.toString()).then(function (rows) {
    state.entries = rows;
    var list = document.getElementById("list");
    if (!rows.length) { list.innerHTML = '<div class="sub">No matching entries.</div>'; return; }
    list.innerHTML = rows.map(function (e) {
      var tags = (e.tags || []).slice(0, 3).map(function (t) { return "#" + esc(t); }).join(" ");
      return '<div class="item" data-id="' + e.id + '">' +
        '<div class="t">' + esc(e.title) + "</div>" +
        '<div class="m"><span class="badge">' + esc(e.kind) + "</span>" +
        (e.project ? "<span>" + esc(e.project) + "</span>" : "") +
        "<span>" + esc((e.created_at || "").slice(0, 10)) + "</span>" +
        "<span>" + tags + "</span></div></div>";
    }).join("");
    Array.prototype.forEach.call(document.querySelectorAll("#list .item"), function (el) {
      el.onclick = function () { selectEntry(Number(el.getAttribute("data-id"))); };
    });
  });
}

function selectEntry(id) {
  state.selected = id;
  Array.prototype.forEach.call(document.querySelectorAll("#list .item"), function (el) {
    el.classList.toggle("on", Number(el.getAttribute("data-id")) === id);
  });
  api("/api/entry/" + id).then(function (e) {
    var conf = e.confidence != null ? " · confidence " + e.confidence : "";
    var tags = (e.tags || []).map(function (t) { return "#" + esc(t); }).join("  ");
    var sources = (e.sources || []).map(function (s) {
      var title = esc(s.title || s.url || "source");
      var link = s.url ? '<a href="' + esc(s.url) + '" target="_blank">' + title + "</a>" : title;
      return '<div class="source">' + link + (s.snippet ? "<div class=sub>" + esc(s.snippet) + "</div>" : "") + "</div>";
    }).join("");
    document.getElementById("right").innerHTML =
      '<div class="detail">' +
      '<div class="toolbar"><button class="btn primary" id="exp">Export view (Markdown)</button>' +
      '<span class="sub">Print to PDF from your browser</span></div>' +
      "<h2>" + esc(e.title) + "</h2>" +
      '<div class="meta"><span class="badge">' + esc(e.kind) + "</span> " +
      (e.project ? esc(e.project) + " · " : "") + esc((e.created_at || "")) + conf +
      (tags ? "<br>" + tags : "") + "</div>" +
      '<div class="body">' + esc(e.body) + "</div>" +
      (sources ? '<div class="sources"><div class="section-title">Sources</div>' + sources + "</div>" : "") +
      "</div>";
    document.getElementById("exp").onclick = exportView;
  });
}

function exportView() {
  var p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (state.kind) p.set("kind", state.kind);
  window.location = "/api/export?" + p.toString();
}

var qEl = document.getElementById("q");
var t;
qEl.oninput = function () {
  clearTimeout(t);
  t = setTimeout(function () { state.q = qEl.value.trim(); loadEntries(); }, 220);
};

loadStatus();
loadEntries();
</script>
</body>
</html>`;
