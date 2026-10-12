/**
 * The page the demo's HTML render session shows: an interactive check of
 * whether a monitor arm's C-clamp fits a desk. Self-contained, styled only
 * with the theme variables every render gets, the way an agent would write
 * it with html_render.
 */
export const MONITOR_FIT_PAGE = `<!doctype html>
<html lang="en">
<head>
<style>
  .fit { display: grid; gap: 16px; }
  .verdict { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 600; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--success); flex: none; }
  .verdict[data-state="warn"] .dot { background: var(--warning); }
  .verdict[data-state="fail"] .dot { background: var(--destructive); }
  .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 20px; align-items: start; }
  @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
  .controls { display: grid; gap: 14px; }
  label { display: grid; gap: 4px; font-size: 13px; color: var(--muted-foreground); }
  .row { display: flex; justify-content: space-between; }
  .row b { color: var(--foreground); font-weight: 600; font-variant-numeric: tabular-nums; }
  input[type="range"] { width: 100%; accent-color: var(--accent); }
  .checks { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; font-size: 13px; }
  .checks li { display: flex; gap: 8px; align-items: baseline; }
  .checks li::before { content: "✓"; color: var(--success); font-weight: 700; width: 12px; }
  .checks li[data-state="warn"]::before { content: "!"; color: var(--warning); }
  .checks li[data-state="fail"]::before { content: "✕"; color: var(--destructive); }
  .well { background: var(--card); border-radius: var(--radius); padding: 16px; }
  svg { display: block; width: 100%; height: auto; }
  .muted { color: var(--muted-foreground); font-size: 12px; }
</style>
</head>
<body>
<div class="fit">
  <div class="verdict" id="verdict"><span class="dot"></span><span id="verdict-text"></span></div>
  <div class="grid">
    <div class="controls">
      <label><span class="row">Desk thickness <b id="thickness-v"></b></span>
        <input id="thickness" type="range" min="10" max="90" value="38"></label>
      <label><span class="row">Free edge behind the lip <b id="edge-v"></b></span>
        <input id="edge" type="range" min="0" max="120" value="70"></label>
      <label><span class="row">Monitor weight <b id="weight-v"></b></span>
        <input id="weight" type="range" min="1" max="15" step="0.5" value="6.5"></label>
      <ul class="checks" id="checks"></ul>
    </div>
    <div class="well">
      <svg id="side" viewBox="0 0 290 200" role="img" aria-label="Side view of the clamp on the desk"></svg>
      <div class="muted">Side view, to scale. Clamp: 10–85 mm opening, 60 mm pads, 2–9 kg arm.</div>
    </div>
  </div>
</div>
<script>
  const CLAMP = { min: 10, max: 85, pad: 60, kgMin: 2, kgMax: 9 };
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function draw(t, edge, state) {
    const s = 1.5, top = 54, edgeX = 250, spine = edgeX + 14;
    const padLen = CLAMP.pad * s, deskH = t * s;
    const jawY = top + CLAMP.max * s + 8;
    const color = state === "ok" ? css("--success") : state === "warn" ? css("--warning") : css("--destructive");
    const railX = edgeX - edge * s;
    const screwX = edgeX - padLen / 2;
    const under = Math.min(top + deskH, jawY - 4);
    $("side").innerHTML = \`
      <rect x="10" y="\${top}" width="\${edgeX - 10}" height="\${deskH}" rx="3" fill="\${css("--muted")}" stroke="\${css("--border-strong")}"/>
      \${edge < 120 ? \`<rect x="\${railX - 14}" y="\${top + deskH}" width="14" height="26" rx="2" fill="\${css("--border-strong")}"/>\` : ""}
      <rect x="\${screwX - 3}" y="\${top - 50}" width="6" height="44" rx="3" fill="\${css("--foreground")}"/>
      <path d="M\${edgeX - padLen} \${top - 5} H\${spine} V\${jawY} H\${edgeX - padLen}" fill="none" stroke="\${color}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>
      <line x1="\${screwX}" y1="\${jawY}" x2="\${screwX}" y2="\${under + 4}" stroke="\${color}" stroke-width="4"/>
      <rect x="\${screwX - 16}" y="\${under}" width="32" height="5" rx="2" fill="\${color}"/>
      <text x="14" y="\${top - 12}" font-size="11" fill="\${css("--muted-foreground")}">\${t} mm desk</text>\`;
  }

  function update() {
    const t = +$("thickness").value, edge = +$("edge").value, kg = +$("weight").value;
    $("thickness-v").textContent = t + " mm";
    $("edge-v").textContent = edge + " mm";
    $("weight-v").textContent = kg + " kg";
    const checks = [
      t < CLAMP.min ? ["fail", "Desk is thinner than the clamp closes (10 mm); add a spacer."]
        : t > CLAMP.max ? ["fail", "Desk is thicker than the clamp opens (85 mm)."]
        : t > CLAMP.max - 8 ? ["warn", "Thickness is near the top of the range; few screw turns left."]
        : ["ok", "Thickness " + t + " mm is inside the 10–85 mm range."],
      edge < CLAMP.pad * 0.75 ? ["fail", "Under-desk rail or drawer blocks the lower pad; it needs about 45 mm clear."]
        : edge < CLAMP.pad ? ["warn", "Lower pad only partly on the desk; use the reinforcement plate."]
        : ["ok", "Lower pad has " + edge + " mm of flat edge."],
      kg > CLAMP.kgMax ? ["fail", "Monitor is heavier than the arm's 9 kg rating."]
        : kg < CLAMP.kgMin ? ["warn", "Too light for the gas spring; the arm will drift up."]
        : ["ok", kg + " kg is inside the 2–9 kg rating."],
    ];
    $("checks").innerHTML = checks.map(([s, text]) => '<li data-state="' + s + '">' + text + "</li>").join("");
    const worst = checks.some(([s]) => s === "fail") ? "fail" : checks.some(([s]) => s === "warn") ? "warn" : "ok";
    $("verdict").dataset.state = worst;
    $("verdict-text").textContent = worst === "ok" ? "It fits." : worst === "warn" ? "It fits, with a caveat." : "It will not fit as is.";
    draw(t, edge, worst);
  }
  for (const id of ["thickness", "edge", "weight"]) $(id).addEventListener("input", update);
  window.addEventListener("message", () => requestAnimationFrame(update));
  update();
</script>
</body>
</html>
`;
