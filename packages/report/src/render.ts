/* ============================================================
   render.ts — render the analytics intermediate + Atlas graph
   into ONE self-contained HTML file.

   The visual design is a direct port of atlas-funnel's viewer
   (flow map with phone-card nodes, drop "heat wash", drop
   badges; a narrowing funnel view with a red lost tail; a
   detail drawer). Everything is inlined: CSS, JS, and base64
   screenshots. The only external references are Google Fonts
   (Funnel Display + Geist Mono).
   ============================================================ */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { healthOf, prettyName } from './funnel.js';
import type {
  Analytics, AtlasGraph, AtlasNode, Health, RenderEdge, RenderNode, RenderPayload,
} from './types.js';

export interface RenderOptions {
  /** Display name for the app (graph name, or the --app argument). */
  appName: string;
}

/* ── payload assembly ───────────────────────────────────────── */

export function renderReport(
  atlas: AtlasGraph,
  analytics: Analytics,
  transitions: Map<string, Map<string, number>>,
  opts: RenderOptions,
): string {
  const byId = new Map<string, AtlasNode>(atlas.nodes.map(n => [n.id, n]));
  const funnel = analytics.funnel;
  const stepIndex = new Map<string, number>(funnel.map(f => [f.screen_id, f.step]));
  const goalId = funnel[funnel.length - 1].screen_id;
  const funnelIds = funnel.map(f => f.screen_id);

  /* positions: funnel spine on row 0, side screens stacked above/below
     the funnel screen they exchange the most users with */
  const pos = new Map<string, { col: number; row: number }>();
  funnel.forEach(f => pos.set(f.screen_id, { col: f.step - 1, row: 0 }));

  const sideIds = Object.keys(analytics.screens)
    .filter(id => !stepIndex.has(id))
    .sort((a, b) => analytics.screens[b].users - analytics.screens[a].users);

  const weightBetween = (a: string, b: string): number =>
    (transitions.get(a)?.get(b) ?? 0) + (transitions.get(b)?.get(a) ?? 0);

  /* first pass: anchor each side screen to the funnel screen it exchanges
     the most users with */
  const anchorOf = new Map<string, string>();
  const unanchored: string[] = [];
  for (const sid of sideIds) {
    let anchor: string | null = null;
    let bestW = 0;
    for (const fid of funnelIds) {
      const w = weightBetween(fid, sid);
      if (w > bestW) {
        bestW = w;
        anchor = fid;
      }
    }
    if (anchor) anchorOf.set(sid, anchor);
    else unanchored.push(sid);
  }
  /* second pass: side screens that only talk to other side screens adopt
     their busiest anchored neighbour's anchor (two hops off the spine) */
  for (const sid of unanchored) {
    let anchor = funnelIds[0];
    let bestW = 0;
    for (const [other, a] of anchorOf) {
      const w = weightBetween(other, sid);
      if (w > bestW) {
        bestW = w;
        anchor = a;
      }
    }
    anchorOf.set(sid, anchor);
  }

  const slotsUsed = new Map<string, number>();
  for (const sid of sideIds) {
    const anchor = anchorOf.get(sid)!;
    const slot = slotsUsed.get(anchor) ?? 0;
    slotsUsed.set(anchor, slot + 1);
    const magnitude = 1.6 + Math.floor(slot / 2) * 1.3;
    pos.set(sid, {
      col: pos.get(anchor)!.col,
      row: (slot % 2 === 0 ? -1 : 1) * magnitude,
    });
  }

  /* nodes */
  const nodes: RenderNode[] = [];
  for (const [id, p] of pos) {
    const node = byId.get(id);
    const stats = analytics.screens[id];
    if (!node || !stats) continue;
    const isGoal = id === goalId;
    const health: Health = isGoal ? 'goal' : healthOf(stats.exit_rate);
    nodes.push({
      id,
      name: node.name,
      title: prettyName(node),
      product_area: node.product_area,
      description: node.description,
      screenshot: screenshotDataUri(node.screenshot),
      col: p.col,
      row: p.row,
      in_funnel: stats.in_funnel,
      step: stepIndex.get(id) ?? null,
      is_goal: isGoal,
      users: stats.users,
      events: stats.events,
      exits: stats.exits,
      exit_rate: stats.exit_rate,
      median_time_s: stats.median_time_s,
      rage_taps: stats.rage_taps,
      avg_taps: stats.avg_taps,
      top_exits: stats.top_exits,
      insight: stats.insight,
      hotspots: stats.hotspots,
      health,
    });
  }

  /* edges */
  const edges: RenderEdge[] = [];
  for (let i = 1; i < funnel.length; i++) {
    const step = funnel[i];
    edges.push({
      source: funnel[i - 1].screen_id,
      target: step.screen_id,
      kind: 'funnel',
      conversion: step.conversion_from_prev,
      drop: step.drop_pct,
      lost: step.lost,
      users: step.users,
      health: healthOf(step.drop_pct),
    });
  }
  for (const sid of sideIds) {
    edges.push({ source: anchorOf.get(sid)!, target: sid, kind: 'side', health: 'side' });
  }

  const first = funnel[0];
  const last = funnel[funnel.length - 1];
  const live = analytics.source === 'posthog';
  const payload: RenderPayload = {
    app: {
      name: opts.appName,
      id: atlas.app_id,
      viewer: `https://app.revyl.ai/apps/${atlas.app_id}/atlas`,
    },
    source: analytics.source,
    source_label: live ? '● PostHog · live' : '● PostHog counts · offline file',
    disclaimer: analytics.disclaimer,
    date_range: analytics.date_range,
    funnel_title:
      funnel.length > 1
        ? `Primary flow · ${first.label} → ${last.label}`
        : `Primary flow · ${first.label}`,
    funnel_sub:
      'Each bar narrows to the share of users still in the flow; the red tail is where they ' +
      'dropped. Every step is a real screen from Revyl Atlas; counts are distinct PostHog users ' +
      `over ${analytics.date_range.toLowerCase()}. Click any row for screen-level detail.`,
    totals: analytics.totals,
    funnel,
    nodes,
    edges,
  };

  return buildHtml(payload, live);
}

/* ── screenshots → data URIs ────────────────────────────────── */

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function screenshotDataUri(absPath: string | null): string | null {
  if (!absPath) return null;
  try {
    const buf = fs.readFileSync(absPath);
    const mime = MIME_BY_EXT[path.extname(absPath).toLowerCase()] ?? 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/* ── HTML assembly ──────────────────────────────────────────── */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtml(payload: RenderPayload, live: boolean): string {
  // <-escape so "</script>" can never terminate the inline block.
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const title = escapeHtml(`Atlas Drop-off · ${payload.app.name}`);
  const appIdShort = escapeHtml(payload.app.id.slice(0, 8));
  const pillClass = live ? 'pill-live' : 'pill-offline';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Funnel+Display:wght@400;500;600;700;800&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
<style>${CSS}</style>
</head>
<body>
<div id="app">

  <header class="topbar">
    <div class="brand">
      <svg class="mark" viewBox="0 0 32 32" aria-hidden="true">
        <defs>
          <linearGradient id="mkg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#d8cffe"/><stop offset="1" stop-color="#9384ee"/>
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="30" height="30" rx="8" fill="#1c1833" stroke="url(#mkg)" stroke-width="1.4"/>
        <path d="M8.5 21.5 L15.5 10.5 L20.5 18.5 L24 13.5" fill="none" stroke="url(#mkg)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="8.5" cy="21.5" r="2.1" fill="#d8cffe"/>
        <circle cx="24" cy="13.5" r="2.1" fill="#9384ee"/>
      </svg>
      <div class="brand-text">
        <div class="brand-title">Atlas <span>Drop-off</span></div>
        <div class="brand-sub">${escapeHtml(payload.app.name)} · ${appIdShort}</div>
      </div>
    </div>

    <div class="topbar-center">
      <div class="viewtoggle" id="viewToggle">
        <button data-view="map" class="active">Flow map</button>
        <button data-view="funnel">Funnel</button>
      </div>
    </div>

    <div class="topbar-right">
      <span class="pill ${pillClass}" id="sourcePill">${escapeHtml(payload.source_label)}</span>
      <span class="daterange" id="dateRange"></span>
      <a class="atlas-link" id="atlasLink" target="_blank" rel="noopener">Open in Atlas ↗</a>
    </div>
  </header>

  <section class="kpis" id="kpis"></section>

  <main class="stage">
    <section class="view view-map active" id="view-map">
      <div class="map-hint" id="mapHint">Drag to pan, scroll to zoom, click any screen for analytics</div>
      <div class="zoom-controls">
        <button id="zoomOut" aria-label="Zoom out">–</button>
        <button id="zoomReset" aria-label="Fit view">⤢</button>
        <button id="zoomIn" aria-label="Zoom in">+</button>
      </div>
      <div class="legend" id="legend">
        <span class="lg"><i class="dot ok"></i>healthy pass-through</span>
        <span class="lg"><i class="dot warn"></i>some drop-off</span>
        <span class="lg"><i class="dot leak"></i>major leak</span>
        <span class="lg"><i class="dot heat"></i>drop-off painted on screen</span>
      </div>
      <div class="canvas-wrap" id="canvasWrap">
        <div class="canvas" id="canvas">
          <svg class="edges" id="edges"></svg>
          <div class="nodes" id="nodes"></div>
        </div>
      </div>
    </section>

    <section class="view view-funnel" id="view-funnel">
      <div class="funnel-head">
        <h2 id="funnelTitle"></h2>
        <p id="funnelSub"></p>
      </div>
      <div class="funnel" id="funnel"></div>
    </section>
  </main>

  <aside class="drawer" id="drawer">
    <button class="drawer-close" id="drawerClose" aria-label="Close">✕</button>
    <div class="drawer-body" id="drawerBody"></div>
  </aside>
  <div class="scrim" id="scrim"></div>

</div>
<script>window.FLOWMAP = ${json};</script>
<script>${CLIENT_JS}</script>
</body>
</html>
`;
}

/* ============================================================
   Inline CSS — ported from atlas-funnel/viewer/style.css
   (Revyl-flavoured premium dark theme).
   ============================================================ */
const CSS = String.raw`
:root{
  --bg:#0a0a10;
  --bg-grid:rgba(176,170,200,.04);
  --panel:#14131c;
  --panel-solid:#14131c;
  --panel-2:#1b1927;
  --stroke:#272534;
  --stroke-soft:#201e2b;
  --ink:#f4f3fa;
  --ink-dim:#bdb9cc;
  --ink-faint:#8d88a2;
  --lav:#d8cffe;
  --lav-deep:#9384ee;
  --indigo:#1c1833;
  --ok:#3fd6a0;
  --warn:#f5b73c;
  --leak:#f76d6d;
  --leak-deep:#ef4444;
  --shadow:0 16px 40px -16px rgba(0,0,0,.65);
  --shadow-node:0 6px 18px -6px rgba(0,0,0,.55);
  --r:14px;
  font-synthesis:none;
}

*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  background:var(--bg);
  color:var(--ink);
  font-family:"Funnel Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  -webkit-font-smoothing:antialiased;
  overflow:hidden;
}
.mono{font-family:"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace}
#app{display:flex;flex-direction:column;height:100vh;height:100dvh}

/* ── top bar ─────────────────────────────────────────────── */
.topbar{
  display:grid;grid-template-columns:1fr auto 1fr;align-items:center;
  padding:14px 22px;gap:16px;
  border-bottom:1px solid var(--stroke-soft);
  background:var(--bg);
  z-index:30;
}
.brand{display:flex;align-items:center;gap:12px}
.brand .mark{width:32px;height:32px;border-radius:8px}
.brand-title{font-weight:700;font-size:17px;letter-spacing:.2px}
.brand-title span{color:var(--lav);font-weight:600}
.brand-sub{font-size:12px;color:var(--ink-dim);margin-top:1px;font-family:"Geist Mono",monospace;letter-spacing:.3px}

.topbar-center{display:flex;justify-content:center}
.viewtoggle{display:flex;background:var(--panel-2);border:1px solid var(--stroke);border-radius:10px;padding:3px}
.viewtoggle button{
  font-family:inherit;font-size:13px;font-weight:600;color:var(--ink-dim);
  background:transparent;border:0;padding:7px 16px;border-radius:7px;cursor:pointer;transition:.15s;
}
.viewtoggle button:hover{color:var(--ink)}
.viewtoggle button.active{background:var(--lav);color:#171327}

.topbar-right{display:flex;align-items:center;gap:14px;justify-content:flex-end}
.pill{font-size:11.5px;font-weight:600;padding:5px 11px;border-radius:7px;letter-spacing:.2px;white-space:nowrap}
.pill-live{color:#7fe9c2;background:rgba(63,214,160,.09);border:1px solid rgba(63,214,160,.28)}
.pill-offline{color:#f3c98a;background:rgba(245,183,60,.1);border:1px solid rgba(245,183,60,.24)}
.daterange{font-size:12px;color:var(--ink-faint);font-family:"Geist Mono",monospace}
.atlas-link{font-size:12.5px;color:var(--lav);text-decoration:none;font-weight:600;opacity:.9}
.atlas-link:hover{opacity:1;text-decoration:underline}

/* ── KPI strip ───────────────────────────────────────────── */
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:16px 22px 8px;z-index:20}
.kpi{
  background:var(--panel);border:1px solid var(--stroke-soft);border-radius:12px;
  padding:15px 17px;position:relative;
}
.kpi .k-label{font-size:11px;color:var(--ink-faint);font-weight:600;letter-spacing:.4px;text-transform:uppercase}
.kpi .k-value{font-size:31px;font-weight:600;margin-top:6px;line-height:1;font-family:"Geist Mono",monospace;letter-spacing:-.5px}
.kpi .k-sub{font-size:12.5px;color:var(--ink-dim);margin-top:7px}
.kpi.leak .k-value{color:var(--leak)}

/* ── stage / views ───────────────────────────────────────── */
.stage{position:relative;flex:1;min-height:0;margin:8px 12px 12px}
.view{position:absolute;inset:0;display:none}
.view.active{display:block}

/* ── flow map ────────────────────────────────────────────── */
.canvas-wrap{
  position:absolute;inset:0;border:1px solid var(--stroke-soft);border-radius:var(--r);
  overflow:hidden;cursor:grab;
  background:
    radial-gradient(var(--bg-grid) 1px, transparent 1.4px) 0 0/30px 30px,
    #08080d;
}
.canvas-wrap.grabbing{cursor:grabbing}
.canvas{position:absolute;top:0;left:0;transform-origin:0 0;will-change:transform}
.edges{position:absolute;top:0;left:0;overflow:visible;pointer-events:none}
.nodes{position:absolute;top:0;left:0}

/* node card */
.node{
  position:absolute;cursor:pointer;transition:transform .16s ease;
  display:flex;flex-direction:column;align-items:center;
}
.node .phone{box-shadow:var(--shadow-node)}
.node:hover{transform:translateY(-2px)}
.node:hover .phone{border-color:var(--lav-deep)}
.node.dim{opacity:.7}
.node.faded{opacity:.2}
.node.selected .phone{border-color:var(--lav);box-shadow:0 0 0 2px rgba(216,207,254,.3), var(--shadow-node)}
.node.selected{opacity:1 !important}
.phone{
  position:relative;border-radius:14px;overflow:hidden;
  background:#0c0917;border:1px solid var(--stroke);
  width:100%;flex:none;align-self:stretch;transition:border-color .16s;
}
.node.funnel .phone{border-radius:16px}
.phone img{display:block;width:100%;height:100%;object-fit:cover;object-position:top}
/* placeholder when a screenshot is missing */
.ph-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;
  background:linear-gradient(160deg,#1b1830 0%,#0c0917 80%)}
.ph-empty .ph-glyph{width:36px;height:36px;border-radius:11px;background:rgba(216,207,254,.12);
  display:grid;place-items:center;font-family:"Geist Mono",monospace;font-size:16px;color:var(--lav)}
.ph-empty .ph-name{font-size:10px;color:var(--ink-faint);font-family:"Geist Mono",monospace;letter-spacing:.4px;text-transform:uppercase}
/* health rail on top */
.phone .rail{position:absolute;top:0;left:0;right:0;height:4px;z-index:4}
.rail.ok{background:var(--ok)} .rail.warn{background:var(--warn)} .rail.leak{background:var(--leak)} .rail.side{background:#3a3357}
.rail.goal{background:linear-gradient(90deg,var(--lav),var(--ok))}
/* drop-off heat wash painted up from the bottom */
.phone .heat{position:absolute;left:0;right:0;bottom:0;z-index:3;pointer-events:none;
  background:linear-gradient(0deg, rgba(239,68,68,.78) 0%, rgba(239,68,68,.32) 45%, rgba(239,68,68,0) 100%);
  mix-blend-mode:screen;}
.phone .heat.warn{background:linear-gradient(0deg, rgba(251,191,36,.62) 0%, rgba(251,191,36,.22) 50%, transparent 100%)}
.phone .heat.ok{background:linear-gradient(0deg, rgba(52,211,153,.32) 0%, transparent 70%)}
.phone .heat.goal{background:linear-gradient(0deg, rgba(216,207,254,.34) 0%, rgba(52,211,153,.12) 45%, transparent 100%)}
/* step chip */
.node .step{
  position:absolute;top:-11px;left:-11px;z-index:6;width:26px;height:26px;border-radius:50%;
  background:var(--lav);color:#171327;font-weight:700;font-size:13px;
  display:grid;place-items:center;font-family:"Geist Mono",monospace;
  border:2px solid var(--bg);
}
/* drop badge */
.node .dropbadge{
  position:absolute;top:8px;right:8px;z-index:6;font-family:"Geist Mono",monospace;
  font-size:12px;font-weight:600;padding:3px 8px;border-radius:7px;
  background:rgba(8,8,13,.82);border:1px solid var(--stroke);
}
.dropbadge.leak{color:#ffb0b0;border-color:rgba(247,109,109,.55);background:rgba(40,12,12,.82)}
.dropbadge.warn{color:#ffd98c;border-color:rgba(245,183,60,.5);background:rgba(38,28,8,.82)}
.dropbadge.ok{color:#7fe9c2;border-color:rgba(63,214,160,.4)}
.dropbadge.goal{color:#171327;background:var(--lav);border-color:transparent;font-weight:700}
/* caption under node */
.node .cap{margin-top:11px;text-align:center;width:100%}
.node .cap .t{font-size:13.5px;font-weight:600;color:var(--ink);line-height:1.2}
.node.side .cap .t{font-size:12px;color:var(--ink-dim);font-weight:500}
.node .cap .u{font-size:11.5px;color:var(--ink-faint);font-family:"Geist Mono",monospace;margin-top:3px;letter-spacing:.2px}

/* edges */
.edge-path{fill:none;stroke-linecap:round}
.edge-path.funnel.ok{stroke:rgba(52,211,153,.55)}
.edge-path.funnel.warn{stroke:rgba(251,191,36,.6)}
.edge-path.funnel.leak{stroke:rgba(251,111,111,.7)}
.edge-path.side{stroke:#2c2647;stroke-dasharray:3 6;stroke-width:1.6}
.edge-label{
  font-family:"Geist Mono",monospace;font-size:12px;font-weight:600;
}
.edge-chip rect{rx:7}

/* zoom + legend + hint */
.zoom-controls{position:absolute;right:16px;bottom:16px;z-index:15;display:flex;flex-direction:column;gap:6px}
.zoom-controls button{
  width:32px;height:32px;border-radius:8px;border:1px solid var(--stroke);background:var(--panel);
  color:var(--ink-dim);font-size:16px;cursor:pointer;font-family:"Geist Mono",monospace;transition:.15s;
}
.zoom-controls button:hover{background:var(--panel-2);border-color:var(--lav-deep);color:var(--ink)}
.legend{position:absolute;left:16px;bottom:14px;z-index:15;display:flex;flex-wrap:wrap;gap:16px;
  background:rgba(10,10,16,.82);border:1px solid var(--stroke-soft);border-radius:10px;padding:9px 14px}
.legend .lg{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--ink-dim)}
.legend .dot{width:10px;height:10px;border-radius:3px;display:inline-block}
.dot.ok{background:var(--ok)} .dot.warn{background:var(--warn)} .dot.leak{background:var(--leak)}
.dot.heat{background:linear-gradient(0deg,var(--leak),transparent)}
.map-hint{position:absolute;left:50%;top:14px;transform:translateX(-50%);z-index:15;
  font-size:11.5px;color:var(--ink-faint);background:rgba(10,10,16,.78);border:1px solid var(--stroke-soft);
  padding:6px 14px;border-radius:8px;font-family:"Geist Mono",monospace;letter-spacing:.2px;
  transition:opacity .45s ease, transform .45s ease;pointer-events:none}
.map-hint.gone{opacity:0;transform:translateX(-50%) translateY(-6px)}

/* ── funnel view (top-to-bottom narrowing bars) ───────────── */
.view-funnel{overflow:auto;padding:4px 2px}
.funnel-head{padding:6px 24px 16px;max-width:920px}
.funnel-head h2{font-size:21px;font-weight:700;letter-spacing:-.2px}
.funnel-head p{color:var(--ink-dim);font-size:13px;margin-top:6px;line-height:1.55;max-width:660px}
.funnel{display:flex;flex-direction:column;gap:3px;padding:4px 24px 40px;max-width:1120px}
.frow{display:grid;grid-template-columns:24px 40px minmax(140px,220px) 1fr 104px;align-items:center;
  gap:15px;padding:9px 12px;border-radius:11px;cursor:pointer;transition:background .14s}
.frow:hover{background:var(--panel)}
.frow .fr-step{font-family:"Geist Mono",monospace;font-size:12px;color:var(--ink-faint);text-align:center}
.frow .fr-thumb{width:40px;height:58px;border-radius:8px;overflow:hidden;border:1px solid var(--stroke);background:#0c0917;position:relative}
.frow .fr-thumb img{width:100%;height:100%;object-fit:cover;object-position:top;display:block}
.frow .fr-title{font-size:14px;font-weight:600;line-height:1.2}
.frow .fr-sub{font-size:11px;color:var(--ink-faint);margin-top:3px;line-height:1.35;
  overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}
.fr-bar{position:relative;height:38px;display:flex;align-items:center}
.fr-bar::before{content:"";position:absolute;left:0;right:0;height:36px;border-radius:9px;background:rgba(255,255,255,.022)}
.fr-bar-outer{position:relative;height:36px;border-radius:9px;overflow:hidden;display:flex;min-width:4px;
  transform-origin:left center;transition:transform .55s cubic-bezier(.16,1,.3,1)}
.fr-fill{flex:0 0 auto;background:var(--lav-deep);min-width:3px}
.frow.goal .fr-fill{background:linear-gradient(90deg,var(--lav-deep),var(--ok))}
.fr-lost{flex:1 1 auto;background:rgba(255,255,255,.05);display:flex;align-items:center;justify-content:center;min-width:0}
.fr-lost.leak{background:rgba(247,109,109,.4)}
.fr-lost.warn{background:rgba(245,183,60,.34)}
.fr-lost .fr-dpct{font-family:"Geist Mono",monospace;font-size:11px;font-weight:600;color:#ffcccc;white-space:nowrap;padding:0 6px}
.fr-lost.warn .fr-dpct{color:#ffe3ad}
.fr-num{text-align:right}
.fr-num .fr-users{font-family:"Geist Mono",monospace;font-size:16px;font-weight:600;letter-spacing:-.3px}
.fr-num .fr-pct{font-size:11px;color:var(--ink-faint);margin-top:2px;font-family:"Geist Mono",monospace}
.frow.goal .fr-num .fr-pct{color:var(--ok)}

/* ── drawer ──────────────────────────────────────────────── */
.scrim{position:fixed;inset:0;background:rgba(5,5,9,.62);opacity:0;pointer-events:none;transition:.25s;z-index:40}
.scrim.open{opacity:1;pointer-events:auto}
.drawer{
  position:fixed;top:0;right:0;height:100%;width:min(560px,94vw);z-index:50;
  background:#100f17;border-left:1px solid var(--stroke);
  box-shadow:var(--shadow);transform:translateX(102%);transition:transform .32s cubic-bezier(.2,.8,.2,1);
  display:flex;flex-direction:column;
}
.drawer.open{transform:translateX(0)}
.drawer-close{position:absolute;top:14px;right:14px;z-index:5;width:32px;height:32px;border-radius:9px;
  border:1px solid var(--stroke);background:var(--panel-solid);color:var(--ink-dim);cursor:pointer;font-size:14px}
.drawer-close:hover{color:var(--ink);border-color:var(--lav-deep)}
.drawer-body{overflow:auto;padding:26px 26px 40px}

.d-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px}
.d-area{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--lav);
  background:rgba(216,207,254,.1);padding:3px 9px;border-radius:6px}
.d-step{font-family:"Geist Mono",monospace;font-size:11px;color:var(--ink-faint)}
.d-title{font-size:23px;font-weight:700;margin:6px 0 2px}
.d-desc{font-size:13px;color:var(--ink-dim);line-height:1.5;margin-bottom:18px}

.d-shot{position:relative;width:228px;margin:0 auto 22px;border-radius:18px;overflow:hidden;
  border:1px solid var(--stroke);box-shadow:var(--shadow);background:#0c0917}
.d-shot img{width:100%;display:block;object-position:top}
.d-shot .heat{position:absolute;left:0;right:0;bottom:0;pointer-events:none;z-index:2}
.hotspot{position:absolute;z-index:3;border-radius:10px;transform:translate(-50%,-50%);
  border:2px solid var(--leak);box-shadow:0 0 0 9999px rgba(8,5,16,.0);}
.hotspot.leak{border-color:var(--leak);background:rgba(239,68,68,.16);animation:pulse 1.8s ease-in-out infinite}
.hotspot.warn{border-color:var(--warn);background:rgba(251,191,36,.14)}
.hotspot.info{border-color:var(--lav-deep);background:rgba(139,123,240,.12)}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.5)}50%{box-shadow:0 0 0 7px rgba(239,68,68,0)}}
.hotspot .htag{position:absolute;left:50%;top:-9px;transform:translate(-50%,-100%);white-space:nowrap;
  font-family:"Geist Mono",monospace;font-size:10.5px;font-weight:600;padding:3px 8px;border-radius:7px;
  background:#1a1224;border:1px solid var(--leak);color:#ffc0c0}
.hotspot.warn .htag{border-color:var(--warn);color:#ffe0a3}
.hotspot.info .htag{border-color:var(--lav-deep);color:var(--lav)}

.d-exit{display:flex;align-items:baseline;gap:12px;padding:14px 16px;border-radius:14px;margin-bottom:16px;
  background:var(--panel);border:1px solid var(--stroke-soft)}
.d-exit .big{font-family:"Geist Mono",monospace;font-size:40px;font-weight:700;line-height:1}
.d-exit.leak .big{color:var(--leak)} .d-exit.warn .big{color:var(--warn)} .d-exit.ok .big{color:var(--ok)}
.d-exit.goal{background:rgba(216,207,254,.07);border-color:rgba(216,207,254,.24)}
.d-exit.goal .big{color:var(--lav)}
.d-exit .lbl{font-size:13px;color:var(--ink-dim)}
.d-exit .lbl b{color:var(--ink);font-weight:600}

.d-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}
.metric{background:var(--panel);border:1px solid var(--stroke-soft);border-radius:12px;padding:12px}
.metric .m-v{font-family:"Geist Mono",monospace;font-size:19px;font-weight:600}
.metric .m-l{font-size:11px;color:var(--ink-faint);margin-top:3px}
.metric.alert .m-v{color:var(--leak)}

.d-section-t{font-size:12px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--ink-dim);margin:6px 0 10px}
.exitrow{display:flex;align-items:center;gap:10px;margin-bottom:9px}
.exitrow .er-label{font-size:12.5px;width:200px;flex:0 0 auto;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.exitrow .er-track{flex:1;height:8px;border-radius:5px;background:var(--panel-2);overflow:hidden}
.exitrow .er-fill{height:100%;border-radius:5px;background:var(--lav-deep)}
.exitrow.exit .er-fill{background:var(--leak)}
.exitrow .er-pct{font-family:"Geist Mono",monospace;font-size:12px;width:42px;text-align:right;flex:0 0 auto;color:var(--ink-dim)}

.d-insight{margin-top:20px;padding:15px 16px;border-radius:12px;line-height:1.55;font-size:13.5px;
  background:rgba(216,207,254,.06);
  border:1px solid rgba(216,207,254,.16)}
.d-insight .ins-t{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--lav);margin-bottom:6px;display:flex;align-items:center;gap:6px}
.d-insight.leak{background:rgba(247,109,109,.07);border-color:rgba(247,109,109,.24)}
.d-insight.leak .ins-t{color:#ffb3b3}

/* ── tactile feedback + focus ─────────────────────────────── */
.viewtoggle button:active,.zoom-controls button:active,.drawer-close:active{transform:translateY(1px)}
button:focus-visible,a:focus-visible{outline:2px solid var(--lav);outline-offset:2px;border-radius:7px}
.node:focus-visible{outline:none}
.node:focus-visible .phone{border-color:var(--lav);box-shadow:0 0 0 2px rgba(216,207,254,.4)}

@media (prefers-reduced-motion: reduce){
  .hotspot.leak{animation:none}
  *{transition-duration:.001s !important}
}

/* ── entrance choreography (motion-only) ──────────────────── */
@media (prefers-reduced-motion: no-preference){
  @keyframes nodeIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
  @keyframes fadeIn{from{opacity:0}to{opacity:1}}
  .node{animation:nodeIn .55s cubic-bezier(.16,1,.3,1) backwards}
  .edge{animation:fadeIn .6s ease backwards}
  .kpi{animation:nodeIn .5s cubic-bezier(.16,1,.3,1) backwards}
  .kpi:nth-child(1){animation-delay:.02s}
  .kpi:nth-child(2){animation-delay:.07s}
  .kpi:nth-child(3){animation-delay:.12s}
  .kpi:nth-child(4){animation-delay:.17s}
}

@media (max-width:900px){
  .kpis{grid-template-columns:repeat(2,1fr)}
  .topbar{grid-template-columns:auto auto;row-gap:10px}
  .topbar-center{grid-column:1/-1;order:3;justify-content:flex-start}
}
`;

/* ============================================================
   Inline client JS — ported from atlas-funnel/viewer/app.js.
   Written without template literals so it embeds cleanly.
   ============================================================ */
const CLIENT_JS = String.raw`
'use strict';
var D = window.FLOWMAP;
function $(s, r) { return (r || document).querySelector(s); }
/* Text-safe by default: every value that can carry Atlas-derived (untrusted,
   model-generated) strings — node names, descriptions, action labels, product
   areas, KPI labels — must go through textContent, never innerHTML. */
function el(t, c, text) { var n = document.createElement(t); if (c) n.className = c; if (text != null) n.textContent = text; return n; }
/* innerHTML escape hatch — ONLY for hard-coded markup with numeric-only
   interpolation (the two goal/exit <b>…</b><br> labels). Never pass
   Atlas-derived or PostHog-derived strings here. */
function elHtml(t, c, h) { var n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; }
function fmt(n) { return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : '' + Math.round(n); }
function pct(x) { var v = Math.round(x * 1000) / 10; return (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)) + '%'; }
var NS = 'http://www.w3.org/2000/svg';
function svgEl(t, a) { var n = document.createElementNS(NS, t); a = a || {}; for (var k in a) n.setAttribute(k, a[k]); return n; }

var reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
function animateCount(node, to, format, dur) {
  dur = dur || 700;
  if (reduceMotion || !isFinite(to)) { node.textContent = format(to); return; }
  var start = null;
  function tick(now) {
    if (start === null) start = now;
    var p = Math.min(1, (now - start) / dur);
    node.textContent = format(to * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(tick); else node.textContent = format(to);
  }
  requestAnimationFrame(tick);
}
var hint = $('#mapHint');
var hintGone = false;
function dismissHint() { if (!hintGone) { hintGone = true; hint.classList.add('gone'); } }

/* layout constants */
var COL_W = 318, ROW_H = 210, PAD = 104;
var FUNNEL_W = 158, SIDE_W = 104, ASPECT = 2.167;
var NODE_ASPECT = 1.96; /* cards crop to the top ~90% of the screen */
function nodeW(n) { return n.in_funnel ? FUNNEL_W : SIDE_W; }
function nodeH(n) { return nodeW(n) * NODE_ASPECT; }

var byId = {}, MIDY = 0;
(function () {
  var minRow = 0;
  D.nodes.forEach(function (n) { byId[n.id] = n; if (n.row < minRow) minRow = n.row; });
  MIDY = PAD + (-minRow) * ROW_H + FUNNEL_W * ASPECT * 0.5;
})();
function center(n) { return { x: PAD + n.col * COL_W, y: MIDY + n.row * ROW_H }; }
function topLeft(n) { var c = center(n); return { x: c.x - nodeW(n) / 2, y: c.y - nodeH(n) / 2 }; }

/* ════════════ KPIs ════════════ */
function renderKPIs() {
  var t = D.totals, leak = t.biggest_leak;
  var goalLabel = D.funnel[D.funnel.length - 1].label;
  var cards = [
    { label: 'Users entering', to: t.sessions, f: function (v) { return fmt(Math.round(v)); }, sub: D.date_range },
    { label: 'End-to-end conversion', to: t.conversion_pct, f: function (v) { return v.toFixed(1) + '%'; }, sub: fmt(t.converted) + ' reached “' + goalLabel + '”' },
    leak
      ? { label: 'Biggest leak', to: Math.round(leak.drop_pct * 100), f: function (v) { return '−' + Math.round(v) + '%'; }, sub: leak.from_label + ' → ' + leak.to_label, leak: true }
      : { label: 'Biggest leak', to: 0, f: function () { return '—'; }, sub: 'no step-to-step drop detected' },
    { label: 'Screens mapped', to: t.screens_mapped, f: function (v) { return '' + Math.round(v); }, sub: t.screens_with_data + ' saw traffic · by Atlas, on cloud devices' }
  ];
  var wrap = $('#kpis');
  cards.forEach(function (c) {
    var k = el('div', 'kpi' + (c.leak ? ' leak' : ''));
    var val = el('div', 'k-value');
    k.append(el('div', 'k-label', c.label), val, el('div', 'k-sub', c.sub));
    wrap.append(k);
    animateCount(val, c.to, c.f);
  });
}

/* ════════════ flow map ════════════ */
var canvas = $('#canvas'), edgesSvg = $('#edges'), nodesLayer = $('#nodes');
var bounds = { w: 0, h: 0 };

function heatHeight(rate) { return Math.min(96, 14 + rate * 150); }
function heatGradient(n) {
  if (n.is_goal) return 'linear-gradient(0deg, rgba(216,207,254,.34) 0%, rgba(52,211,153,.12) 45%, transparent 100%)';
  var rgb = n.health === 'leak' ? '239,68,68' : n.health === 'warn' ? '251,191,36' : '52,211,153';
  return 'linear-gradient(0deg, rgba(' + rgb + ',' + (0.2 + n.exit_rate).toFixed(2) + ') 0%, transparent 80%)';
}
function phoneVisual(n, parent) {
  if (n.screenshot) {
    var img = new Image(); img.src = n.screenshot; img.loading = 'lazy'; parent.append(img);
  } else {
    var ph = el('div', 'ph-empty');
    ph.append(el('div', 'ph-glyph', (n.title || '?').charAt(0).toUpperCase()));
    ph.append(el('div', 'ph-name', 'no screenshot'));
    parent.append(ph);
  }
}

function renderNodes() {
  D.nodes.forEach(function (n) {
    var tl = topLeft(n), w = nodeW(n), h = nodeH(n);
    var node = el('div', 'node ' + (n.in_funnel ? 'funnel' : 'side dim'));
    node.dataset.id = n.id;
    node.style.left = tl.x + 'px';
    node.style.top = tl.y + 'px';
    node.style.width = w + 'px';
    node.style.animationDelay = (0.05 + n.col * 0.045) + 's';

    var phone = el('div', 'phone');
    phone.style.width = w + 'px';
    phone.style.height = h + 'px';
    phone.append(el('div', 'rail ' + n.health));
    phoneVisual(n, phone);
    var heat = el('div', 'heat ' + n.health);
    heat.style.height = heatHeight(n.exit_rate) + '%';
    phone.append(heat);
    if (n.is_goal) phone.append(el('div', 'dropbadge goal', '✓ ' + n.title));
    else if (n.in_funnel) phone.append(el('div', 'dropbadge ' + n.health, '▼ ' + pct(n.exit_rate)));
    node.append(phone);
    if (n.step) node.append(el('div', 'step', '' + n.step));

    var cap = el('div', 'cap');
    cap.append(el('div', 't', n.title));
    cap.append(el('div', 'u', fmt(n.users) + ' users'));
    node.append(cap);

    node.addEventListener('click', function (e) { e.stopPropagation(); dismissHint(); openDrawer(n.id); });
    node.addEventListener('mouseenter', function () { highlight(n.id); });
    node.addEventListener('mouseleave', function () { highlight(null); });
    nodesLayer.append(node);
  });
  var maxX = 0, maxY = 0;
  D.nodes.forEach(function (n) {
    var tl = topLeft(n);
    maxX = Math.max(maxX, tl.x + nodeW(n));
    maxY = Math.max(maxY, tl.y + nodeH(n) + 46);
  });
  bounds = { w: maxX + PAD, h: maxY + PAD };
  canvas.style.width = bounds.w + 'px';
  canvas.style.height = bounds.h + 'px';
  edgesSvg.setAttribute('width', bounds.w);
  edgesSvg.setAttribute('height', bounds.h);
}

function renderEdges() {
  D.edges.forEach(function (e) {
    var s = byId[e.source], t = byId[e.target];
    if (!s || !t) return;
    var cs = center(s), ct = center(t);
    var g = svgEl('g', { class: 'edge', 'data-s': e.source, 'data-t': e.target });
    g.style.animationDelay = (0.14 + (s.col || 0) * 0.045) + 's';

    if (e.kind === 'funnel') {
      var x1 = cs.x + nodeW(s) / 2, y1 = cs.y, x2 = ct.x - nodeW(t) / 2, y2 = ct.y;
      var dx = Math.max(40, (x2 - x1) * 0.5);
      var d = 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + dx) + ' ' + y1 + ', ' + (x2 - dx) + ' ' + y2 + ', ' + x2 + ' ' + y2;
      var wgt = Math.min(5, 1.5 + Math.sqrt(e.users || 0) / 34);
      g.append(svgEl('path', { class: 'edge-path funnel ' + e.health, d: d, 'stroke-width': wgt }));
      var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      var leak = e.health === 'leak';
      var txt = leak
        ? '−' + Math.round(e.drop * 100) + '% · ' + fmt(e.lost)
        : Math.round(e.conversion * 100) + '%';
      var chipW = leak ? 124 : 56, chipH = 23;
      g.append(svgEl('rect', { x: mx - chipW / 2, y: my - chipH / 2, width: chipW, height: chipH, rx: 7,
        fill: '#0d0d13', stroke: leak ? 'rgba(247,109,109,.5)' : '#2c2939' }));
      var tEl = svgEl('text', { x: mx, y: my + 4, 'text-anchor': 'middle', class: 'edge-label',
        fill: leak ? '#ffb0b0' : '#bdb9cc' });
      tEl.textContent = txt;
      g.append(tEl);
    } else {
      var d2 = 'M ' + cs.x + ' ' + cs.y + ' C ' + cs.x + ' ' + ((cs.y + ct.y) / 2) + ', ' + ct.x + ' ' + ((cs.y + ct.y) / 2) + ', ' + ct.x + ' ' + ct.y;
      g.append(svgEl('path', { class: 'edge-path side', d: d2 }));
    }
    edgesSvg.append(g);
  });
}

function highlight(id) {
  var nbrs = {};
  if (id) {
    nbrs[id] = true;
    D.edges.forEach(function (e) {
      if (e.source === id) nbrs[e.target] = true;
      if (e.target === id) nbrs[e.source] = true;
    });
  }
  nodesLayer.querySelectorAll('.node').forEach(function (n) {
    n.classList.toggle('faded', !!id && !nbrs[n.dataset.id]);
  });
  edgesSvg.querySelectorAll('.edge').forEach(function (g) {
    var on = !id || g.dataset.s === id || g.dataset.t === id;
    g.style.opacity = on ? 1 : 0.12;
  });
}

/* ── pan / zoom ── */
var view = { x: 0, y: 0, s: 1 };
var wrap = $('#canvasWrap');
function applyView() { canvas.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.s + ')'; }
function fit() {
  var r = wrap.getBoundingClientRect();
  var s = Math.min((r.width - 40) / bounds.w, (r.height - 40) / bounds.h, 1);
  view.s = Math.max(s, 0.3);
  view.x = (r.width - bounds.w * view.s) / 2;
  view.y = (r.height - bounds.h * view.s) / 2;
  applyView();
}
function defaultView() {
  var r = wrap.getBoundingClientRect();
  var fitAll = Math.min((r.width - 40) / bounds.w, (r.height - 40) / bounds.h);
  view.s = Math.min(1.0, Math.max(fitAll, 0.82));
  view.x = (bounds.w * view.s <= r.width - 40) ? (r.width - bounds.w * view.s) / 2 : 44;
  view.y = r.height * 0.44 - MIDY * view.s;
  applyView();
}
function zoomAt(cx, cy, factor) {
  var ns = Math.min(2.2, Math.max(0.28, view.s * factor));
  var k = ns / view.s;
  view.x = cx - (cx - view.x) * k;
  view.y = cy - (cy - view.y) * k;
  view.s = ns; applyView();
}
wrap.addEventListener('wheel', function (e) {
  e.preventDefault(); dismissHint();
  var r = wrap.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });
var drag = null, dragging = false;
wrap.addEventListener('pointerdown', function (e) {
  drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, id: e.pointerId };
  dragging = false;
});
wrap.addEventListener('pointermove', function (e) {
  if (!drag) return;
  var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!dragging && Math.hypot(dx, dy) > 4) {
    dragging = true; dismissHint(); wrap.classList.add('grabbing');
    try { wrap.setPointerCapture(drag.id); } catch (_) {}
  }
  if (dragging) { view.x = drag.vx + dx; view.y = drag.vy + dy; applyView(); }
});
wrap.addEventListener('pointerup', function () {
  if (dragging && drag) { try { wrap.releasePointerCapture(drag.id); } catch (_) {} }
  wrap.classList.remove('grabbing');
  drag = null;
});
wrap.addEventListener('click', function (e) {
  if (!dragging && (e.target === wrap || e.target === canvas || e.target === edgesSvg)) closeDrawer();
});
$('#zoomIn').onclick = function () { var r = wrap.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.18); };
$('#zoomOut').onclick = function () { var r = wrap.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1 / 1.18); };
$('#zoomReset').onclick = fit;

/* ════════════ funnel view ════════════ */
function edgeHealth(drop) { return drop >= 0.18 ? 'leak' : drop >= 0.12 ? 'warn' : 'ok'; }

function renderFunnel() {
  var fwrap = $('#funnel');
  var start = Math.max(1, D.funnel[0].users);
  D.funnel.forEach(function (f, i) {
    var n = byId[f.screen_id];
    var lastIdx = D.funnel.length - 1;
    var isGoal = i === lastIdx;
    var next = i < lastIdx ? D.funnel[i + 1] : null;
    var outDrop = next ? next.drop_pct : 0;
    var health = next ? edgeHealth(outDrop) : 'ok';
    var barPct = Math.min(100, f.users / start * 100);
    var fillFrac = next ? Math.min(100, next.users / Math.max(1, f.users) * 100) : 100;

    var row = el('div', 'frow' + (isGoal ? ' goal' : ''));
    row.append(el('div', 'fr-step', '' + f.step));

    var thumb = el('div', 'fr-thumb');
    if (n && n.screenshot) { var img = new Image(); img.src = n.screenshot; img.loading = 'lazy'; thumb.append(img); }
    row.append(thumb);

    var name = el('div', 'fr-name');
    name.append(el('div', 'fr-title', f.label));
    if (n && n.description) name.append(el('div', 'fr-sub', n.description));
    row.append(name);

    var bar = el('div', 'fr-bar');
    var outer = el('div', 'fr-bar-outer');
    outer.style.width = barPct + '%';
    var fill = el('div', 'fr-fill');
    fill.style.flexBasis = fillFrac + '%';
    var lost = el('div', 'fr-lost ' + health);
    if (next && outDrop >= 0.1) lost.append(el('div', 'fr-dpct', '−' + Math.round(outDrop * 100) + '%'));
    outer.append(fill, lost);
    if (!reduceMotion) {
      outer.style.transform = 'scaleX(0)';
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        outer.style.transitionDelay = (0.04 + i * 0.05) + 's';
        outer.style.transform = 'scaleX(1)';
      }); });
    }
    bar.append(outer); row.append(bar);

    var num = el('div', 'fr-num');
    num.append(el('div', 'fr-users', fmt(f.users)));
    num.append(el('div', 'fr-pct', (isGoal ? '✓ ' : '') + Math.round(f.users / start * 100) + '%'));
    row.append(num);

    row.onclick = function () { openDrawer(f.screen_id); };
    fwrap.append(row);
  });
}

/* ════════════ drawer ════════════ */
var drawer = $('#drawer'), scrim = $('#scrim'), dbody = $('#drawerBody');
function markSelected(id) {
  nodesLayer.querySelectorAll('.node.selected').forEach(function (n) { n.classList.remove('selected'); });
  if (id) {
    var n = nodesLayer.querySelector('.node[data-id="' + id + '"]');
    if (n) n.classList.add('selected');
  }
}
function openDrawer(id) {
  var n = byId[id]; if (!n) return;
  markSelected(id);
  dbody.innerHTML = '';
  var head = el('div', 'd-head');
  head.append(el('span', 'd-area', n.product_area));
  if (n.step) head.append(el('span', 'd-step', 'FUNNEL STEP ' + n.step));
  dbody.append(head);
  dbody.append(el('div', 'd-title', n.title));
  if (n.description) dbody.append(el('div', 'd-desc', n.description));

  /* screenshot + heat + hotspots */
  var shot = el('div', 'd-shot');
  shot.style.height = (230 * ASPECT) + 'px';
  if (n.screenshot) { var img = new Image(); img.src = n.screenshot; shot.append(img); }
  else { var ph = el('div', 'ph-empty'); ph.append(el('div', 'ph-glyph', (n.title || '?').charAt(0).toUpperCase())); ph.append(el('div', 'ph-name', 'no screenshot')); shot.append(ph); }
  var heat = el('div', 'heat ' + n.health);
  heat.style.height = heatHeight(n.exit_rate) + '%';
  heat.style.background = heatGradient(n);
  heat.style.mixBlendMode = 'screen';
  shot.append(heat);
  (n.hotspots || []).forEach(function (hs) {
    var box = el('div', 'hotspot ' + (hs.kind || 'leak'));
    box.style.left = (hs.cx * 100) + '%';
    box.style.top = (hs.cy * 100) + '%';
    box.style.width = (hs.w * 100) + '%';
    box.style.height = (hs.h * 100) + '%';
    box.append(el('div', 'htag', hs.label));
    shot.append(box);
  });
  dbody.append(shot);

  /* exit-rate hero (goal framed positively) */
  var ex = el('div', 'd-exit ' + n.health);
  if (n.is_goal) {
    ex.append(el('div', 'big mono', '✓'));
    /* hard-coded markup + numeric-only interpolation — safe for elHtml */
    ex.append(elHtml('div', 'lbl', '<b>Goal reached.</b><br>' + fmt(n.users) + ' of ' + fmt(D.totals.sessions) + ' users converted'));
  } else {
    ex.append(el('div', 'big mono', pct(n.exit_rate)));
    ex.append(elHtml('div', 'lbl', 'of users <b>exit here</b><br>' + fmt(n.exits) + ' of ' + fmt(n.users) + ' users'));
  }
  dbody.append(ex);

  /* metric grid — cells with unavailable metrics are simply omitted */
  var metrics = [{ v: fmt(n.users), l: 'Unique users' }];
  if (n.events != null && n.events > 0) {
    metrics.push({ v: fmt(n.events), l: 'Screen views' });
    if (n.users > 0) metrics.push({ v: (n.events / n.users).toFixed(1) + '×', l: 'Views per user' });
  }
  if (n.median_time_s != null) metrics.push({ v: n.median_time_s + 's', l: 'Median on screen' });
  if (n.avg_taps != null) metrics.push({ v: '' + n.avg_taps, l: 'Avg taps' });
  metrics.push({ v: fmt(n.exits), l: n.is_goal ? 'Left after converting' : 'Exits here', alert: n.health === 'leak' });
  metrics.push({ v: pct(n.exit_rate), l: 'Exit rate' });
  if (n.rage_taps != null) metrics.push({ v: '' + n.rage_taps, l: 'Rage taps', alert: n.rage_taps > 100 });
  metrics.push({ v: n.is_goal ? 'Goal' : n.health === 'leak' ? 'High' : n.health === 'warn' ? 'Med' : 'Low', l: 'Drop-off severity' });
  var grid = el('div', 'd-grid');
  metrics.forEach(function (m) {
    var c = el('div', 'metric' + (m.alert ? ' alert' : ''));
    c.append(el('div', 'm-v', m.v), el('div', 'm-l', m.l));
    grid.append(c);
  });
  dbody.append(grid);

  /* where they go next */
  if (n.top_exits && n.top_exits.length) {
    dbody.append(el('div', 'd-section-t', 'Where they go next'));
    n.top_exits.forEach(function (t) {
      var isExit = t.to === '__exit__';
      var row = el('div', 'exitrow' + (isExit ? ' exit' : ''));
      row.append(el('div', 'er-label', t.label));
      var track = el('div', 'er-track');
      var fill = el('div', 'er-fill');
      fill.style.width = (t.pct * 100) + '%';
      track.append(fill);
      row.append(track);
      row.append(el('div', 'er-pct mono', Math.round(t.pct * 100) + '%'));
      dbody.append(row);
    });
  }

  /* insight callout */
  if (n.insight) {
    var ins = el('div', 'd-insight' + (n.health === 'leak' ? ' leak' : ''));
    ins.append(el('div', 'ins-t', (n.health === 'leak' ? '⚠ ' : '◆ ') + 'Drop-off insight'));
    ins.append(document.createTextNode(n.insight));
    dbody.append(ins);
  }

  drawer.classList.add('open'); scrim.classList.add('open');
}
function closeDrawer() { drawer.classList.remove('open'); scrim.classList.remove('open'); markSelected(null); }
$('#drawerClose').onclick = closeDrawer;
scrim.onclick = closeDrawer;
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

/* ════════════ view toggle ════════════ */
$('#viewToggle').addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  $('#viewToggle .active').classList.remove('active'); b.classList.add('active');
  var v = b.dataset.view;
  $('#view-map').classList.toggle('active', v === 'map');
  $('#view-funnel').classList.toggle('active', v === 'funnel');
  if (v === 'map') requestAnimationFrame(fit);
});

/* ════════════ boot ════════════ */
(function boot() {
  $('#dateRange').textContent = D.date_range;
  $('#sourcePill').title = D.disclaimer;
  $('#atlasLink').href = D.app.viewer;
  $('#funnelTitle').textContent = D.funnel_title;
  $('#funnelSub').textContent = D.funnel_sub;
  renderKPIs();
  renderNodes();
  renderEdges();
  renderFunnel();
  defaultView();
  window.addEventListener('resize', function () {
    if ($('#view-map').classList.contains('active')) defaultView();
  });
})();
`;
