"use strict";

// ===========================================================================
// app.js — controller. Owns the single source of truth (current date + active
// target), wires the DOM controls and the 3D scene together, and writes the
// readout. All maths comes from astro.js; all rendering from sphere.js.
// ===========================================================================

import {
  julianDate, sunPosition, obliquity,
  eclipticToRaDec, v3paReport, inCVZ, visibilityWindows, availablePA,
  ramDirection, inMAZ,
  mod360,
} from "./astro.js";
import { createSphere } from "./sphere.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  date: new Date(Date.UTC(2027, 0, 1)), // current observing date (UTC)
  target: null,                          // pinned target {ra, dec} or null
  hover: null,                           // transient hover target {ra, dec}
};

// Reference year for the day-of-year slider (visibility is ~annually periodic).
const YEAR_START = new Date(Date.UTC(2027, 0, 1));
// Slider spans Jan 1 2027 -> Dec 30 2028 (inclusive).
const DAY_SPAN = 729;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const el = {
  canvas: document.getElementById("scene"),
  dateInput: document.getElementById("date-input"),
  daySlider: document.getElementById("day-slider"),
  dayLabel: document.getElementById("day-label"),
  raInput: document.getElementById("ra-input"),
  decInput: document.getElementById("dec-input"),
  lookupBtn: document.getElementById("lookup-btn"),
  clearBtn: document.getElementById("clear-btn"),
  fieldsCheck: document.getElementById("fields-check"),
  mazCheck: document.getElementById("maz-check"),
  targetReadout: document.getElementById("target-readout"),
  targetTitle: document.getElementById("target-title"),
  windows: document.getElementById("windows"),
  tooltip: document.getElementById("tooltip"),
};

// ---------------------------------------------------------------------------
// Formatting helpers (mirror cosmo-calc's "—" fallback + tabular numbers)
// ---------------------------------------------------------------------------
const DASH = "—";
function fmt(x, d = 2) {
  return Number.isFinite(x) ? x.toFixed(d) : DASH;
}
// RA in degrees -> "HHh MMm" for readability.
function raToHMS(ra) {
  const hours = ra / 15;
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------
const scene = createSphere(el.canvas, {
  onHover: (rd, ev, field) => onHover(rd, ev, field),
  onRingClick: (lon) => setDateFromEclipticLon(lon),
  // Target is set only via RA/Dec lookup — clicking the sphere no longer pins.
});

// Ecliptic samples for the current epoch (obliquity barely changes; recompute
// once per date is cheap and keeps the ring exact).
function buildEclipticSamples(jd) {
  const eps = obliquity(jd);
  const samples = [];
  for (let lon = 0; lon < 360; lon += 2) {
    const rd = eclipticToRaDec(lon, 0, eps);
    samples.push({ lon, ra: rd.ra, dec: rd.dec });
  }
  return samples;
}

// CVZ poles (north/south ecliptic poles) in RA/Dec.
function cvzPoles(jd) {
  const eps = obliquity(jd);
  return {
    north: eclipticToRaDec(0, 90, eps),
    south: eclipticToRaDec(0, -90, eps),
  };
}

// ---------------------------------------------------------------------------
// Date <-> ecliptic longitude (Sun's longitude ~ position on the ring)
// ---------------------------------------------------------------------------
function setDateFromEclipticLon(lon) {
  // Find the day in the reference year whose Sun ecliptic longitude is closest.
  let best = state.date, bestDiff = Infinity;
  for (let i = 0; i < 366; i++) {
    const d = new Date(YEAR_START.getTime() + i * 86400000);
    const sun = sunPosition(julianDate(d));
    let diff = Math.abs(mod360(sun.eclipticLon - lon));
    if (diff > 180) diff = 360 - diff;
    if (diff < bestDiff) { bestDiff = diff; best = d; }
  }
  state.date = best;
  syncDateControls();
  render();
}

function dayOfYear(d) {
  return Math.round((d.getTime() - YEAR_START.getTime()) / 86400000);
}

// Set the observing date from a day offset (clamped to the span) and refresh.
function setDateByDay(day) {
  const d = Math.max(0, Math.min(DAY_SPAN, Math.round(day)));
  state.date = new Date(YEAR_START.getTime() + d * 86400000);
  syncDateControls();
  render();
}

function syncDateControls() {
  el.dateInput.value = fmtDate(state.date);
  el.daySlider.value = String(Math.max(0, Math.min(DAY_SPAN, dayOfYear(state.date))));
  el.dayLabel.textContent = state.date.toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

// ---------------------------------------------------------------------------
// Target handling
// ---------------------------------------------------------------------------
function pinTarget(ra, dec) {
  state.target = { ra: mod360(ra), dec };
  el.raInput.value = fmt(state.target.ra, 3);
  el.decInput.value = fmt(state.target.dec, 3);
  updateTargetMarker();
  renderTargetReadout();
}

function clearTarget() {
  state.target = null;
  scene.setTarget(null);
  renderTargetReadout();
}

// Position + colour the target marker for the current date (red if observable
// now, grey if not). Recomputed on both pinning and date changes.
function updateTargetMarker() {
  if (!state.target) { scene.setTarget(null); return; }
  const sun = sunPosition(julianDate(state.date));
  const rep = v3paReport(state.target.ra, state.target.dec, sun);
  scene.setTarget(state.target.ra, state.target.dec, rep.observable, rep.marginal);
}

function onHover(rd, ev, field) {
  state.hover = rd;
  if (rd && !state.target) {
    // Live readout for the hovered point when nothing is pinned.
    renderTargetReadout();
  }
  // Floating tooltip near the cursor with the essentials.
  if (rd) {
    const jd = julianDate(state.date);
    const sun = sunPosition(jd);
    // Over a classic field, describe that field (using its own coordinates);
    // otherwise report the cursor point.
    const p = field || rd;
    const rep = v3paReport(p.ra, p.dec, sun);
    const maz = rep.observable && inMAZ(p.ra, p.dec, sun, obliquity(jd));
    el.tooltip.hidden = false;
    el.tooltip.style.left = `${ev.clientX + 14}px`;
    el.tooltip.style.top = `${ev.clientY + 14}px`;
    const obs = rep.observable
      ? `V3PA ${fmt(rep.nominalV3PA, 1)}°` +
        (rep.marginal ? ` · <span class="warn">marginal</span>` : "") +
        (maz ? ` · <span class="maz">MAZ</span>` : "")
      : `<span class="bad">not observable</span>`;
    if (field) {
      // Over a classic field: show its text, its own RA/Dec, then elong + V3PA.
      el.tooltip.innerHTML =
        `<b>${field.name}</b><br>` +
        `<span class="unit">${field.desc}</span><br>` +
        `RA ${fmt(field.ra, 2)}° &nbsp; Dec ${fmt(field.dec, 2)}°<br>` +
        `elong ${fmt(rep.elongation, 1)}° · ` +
        obs;
    } else {
      el.tooltip.innerHTML =
        `RA ${fmt(rd.ra, 1)}° &nbsp; Dec ${fmt(rd.dec, 1)}°<br>` +
        `elong ${fmt(rep.elongation, 1)}° · ` +
        obs;
    }
  } else {
    el.tooltip.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Readout rendering
// ---------------------------------------------------------------------------
function renderTargetReadout() {
  const t = state.target || state.hover;
  if (!t) {
    el.targetTitle.textContent = "Target — hover or look one up";
    el.targetReadout.innerHTML = "";
    el.windows.innerHTML = "";
    return;
  }
  const jd = julianDate(state.date);
  const sun = sunPosition(jd);
  const rep = v3paReport(t.ra, t.dec, sun);
  const cvz = inCVZ(t.ra, t.dec, jd);
  const maz = rep.observable && inMAZ(t.ra, t.dec, sun, obliquity(jd));

  el.targetTitle.textContent = state.target
    ? `Target (pinned)`
    : `Target (hover)`;

  let obsCell = rep.observable
    ? rep.marginal
      ? `<span class="warn">Marginal</span>` +
        `<span class="info" tabindex="0" role="button" aria-label="Why marginal?">i` +
        `<span class="info-pop">` +
        `Whether this is really observable depends on JWST's exact position in its L2 orbit.<br><br>` +
        `This tool computes from Earth's orbit instead, which can be off by a few degrees — ` +
        `so this close to the edge, the result isn't reliable.<br><br>` +
        `Please check APT for accurate info.` +
        `</span></span>`
      : `<span class="good">Yes</span>`
    : `<span class="bad">No</span>`;
  if (cvz) obsCell += ` <span class="unit">· CVZ (year-round)</span>`;

  el.targetReadout.innerHTML =
    row("RA", `${fmt(t.ra, 3)}° <span class="unit">(${raToHMS(t.ra)})</span>`) +
    row("Dec", `${fmt(t.dec, 3)}°`) +
    row("Solar elongation", `${fmt(rep.elongation, 2)}°`) +
    row("Observable now", obsCell) +
    row("Meteoroid", rep.observable
      ? (maz
          ? `<span class="maz">Unsafe Zone</span>`
          : `<span class="good">Safe Zone</span>`) +
        `<span class="info" tabindex="0" role="button" aria-label="What is the meteoroid unsafe zone?">i` +
        `<span class="info-pop">The Micrometeoroid Avoidance Zone is where JWST ` +
        `faces a higher risk of head-on micrometeoroid hits.<br><br>` +
        `It is a 75° cone around JWST's orbital-motion direction, and a soft ` +
        `constraint: observations in the meteoroid unsafe zone should be ` +
        `minimized and need justification in APT.</span></span>`
      : DASH) +
    row("Nominal V3PA", rep.observable ? `${fmt(rep.nominalV3PA, 2)}°` : DASH) +
    row("Allowed roll", rep.observable ? `±${fmt(rep.rollHalfWidth, 1)}°` : DASH) +
    row("V3PA range", rep.observable
      ? `${fmt(rep.v3paMin, 1)}° – ${fmt(rep.v3paMax, 1)}°`
      : DASH) +
    row("NIRSpec aperture PA", rep.observable ? `${fmt(rep.nirspecAperturePA, 2)}°` : DASH) +
    row("NIRSpec PA range", rep.observable
      ? `${fmt(rep.nirspecPAMin, 1)}° – ${fmt(rep.nirspecPAMax, 1)}°`
      : DASH);

  renderWindows(t);
}

function renderWindows(t) {
  const wins = visibilityWindows(t.ra, t.dec, YEAR_START, DAY_SPAN + 1);
  const chart = buildPAChart(t); // built first: the bar reuses its per-day samples
  const bar = buildVisibilityBar(wins, chart.samples);
  const rows = wins.length
    ? wins
        .map((w) => {
          const s = fmtWinDate(w.start);
          const e = fmtWinDate(w.end);
          return `<div class="win"><span>${s} – ${e}</span><span class="unit">${w.days} d</span></div>`;
        })
        .join("")
    : `<div class="win-none">No observable dates in this span.</div>`;
  el.windows.innerHTML =
    `<div class="win-title">Visibility windows (2027–2028)</div>${bar}` +
    chart.html +
    rows +
    renderAvailablePA(t);
  attachBarHover(t);
  attachChartHover(chart, t);
}

function fmtWinDate(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// A horizontal timeline of the whole span: grey = not observable, green =
// observable, amber = marginal (within FOR_MARGIN of an FOR edge). Window edges
// are ticked; a marker shows the current date. Hover is wired up separately
// (attachBarHover) so it can read per-day PA on the fly.
function buildVisibilityBar(wins, samples) {
  const pct = (dayOff) => (Math.max(0, Math.min(DAY_SPAN, dayOff)) / DAY_SPAN) * 100;
  let segs = "";
  let ticks = "";
  for (const w of wins) {
    const a = dayOfYear(w.start);
    const b = dayOfYear(w.end);
    const left = pct(a);
    const width = ((b - a + 1) / DAY_SPAN) * 100;
    segs += `<div class="win-seg" style="left:${left}%;width:${width}%"></div>`;
    ticks += `<div class="win-tick" style="left:${pct(a)}%"></div>`;
    ticks += `<div class="win-tick" style="left:${pct(b + 1)}%"></div>`;
  }
  // Overlays on the green segments, as contiguous runs: meteoroid-unsafe days
  // get a striped shading over the green; marginal days are treated as
  // unavailable and painted the bar's grey (drawn last, so they win).
  const overlayRuns = (key, cls) => {
    for (let i = 0; i <= DAY_SPAN; ) {
      if (!samples[i] || !samples[i][key]) { i++; continue; }
      let j = i;
      while (j + 1 <= DAY_SPAN && samples[j + 1] && samples[j + 1][key]) j++;
      segs += `<div class="win-seg ${cls}" style="left:${pct(i)}%;width:${((j - i + 1) / DAY_SPAN) * 100}%"></div>`;
      i = j + 1;
    }
  };
  overlayRuns("maz", "maz");
  overlayRuns("marginal", "marginal");
  const yr2 = pct(dayOfYear(new Date(Date.UTC(2028, 0, 1))));
  const now = pct(dayOfYear(state.date));
  return (
    `<div class="win-bar" id="win-bar">${segs}${ticks}` +
    `<div class="win-yeardiv" style="left:${yr2}%"></div>` +
    `<div class="win-now" style="left:${now}%"></div>` +
    `<div class="win-hover" id="win-hover"></div></div>` +
    `<div class="win-axis"><span class="win-axlab" style="left:0%">2027</span>` +
    `<span class="win-axlab win-axlab-c" style="left:${yr2}%">2028</span></div>`
  );
}

// Hovering the bar reads the day under the cursor and shows that date's V3PA and
// NIRSpec aperture-PA range in the floating tooltip.
function attachBarHover(t) {
  const bar = document.getElementById("win-bar");
  if (!bar) return;
  const guide = document.getElementById("win-hover");
  bar.addEventListener("mousemove", (ev) => {
    const rect = bar.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    if (guide) { guide.style.left = `${frac * 100}%`; guide.style.display = "block"; }
    const day = Math.round(frac * DAY_SPAN);
    const d = new Date(YEAR_START.getTime() + day * 86400000);
    const jd = julianDate(d);
    const sun = sunPosition(jd);
    const rep = v3paReport(t.ra, t.dec, sun);
    const maz = rep.observable && inMAZ(t.ra, t.dec, sun, obliquity(jd));
    el.tooltip.hidden = false;
    el.tooltip.style.left = `${ev.clientX + 14}px`;
    el.tooltip.style.top = `${ev.clientY + 14}px`;
    el.tooltip.innerHTML =
      `<b>${fmtWinDate(d)}</b><br>` +
      (rep.observable
        ? `V3PA ${fmt(rep.v3paMin, 0)}°–${fmt(rep.v3paMax, 0)}°<br>` +
          `<span class="unit">NIRSpec APA ${fmt(rep.nirspecPAMin, 0)}°–${fmt(rep.nirspecPAMax, 0)}°</span>` +
          (rep.marginal ? `<br><span class="warn">marginal — check APT</span>` : "") +
          (maz ? `<br><span class="maz">meteoroid unsafe zone</span>` : "")
        : `<span class="bad">not observable</span>`);
  });
  bar.addEventListener("mouseleave", () => {
    el.tooltip.hidden = true;
    if (guide) guide.style.display = "none";
  });
  bar.addEventListener("click", (ev) => {
    const rect = bar.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    setDateByDay(frac * DAY_SPAN);
  });
}

// SVG line chart of nominal V3PA and NIRSpec aperture PA vs date over the span.
// PA is circular, so a subpath is broken wherever the target is unobservable or
// the angle wraps across 0/360. Returns { html, samples, px, py } — samples holds
// per-day {v3, apa} (or null) and px/py map day/angle into viewBox coordinates.
const PAC = { W: 300, H: 136, L: 26, R: 12, T: 8, B: 28 };
function buildPAChart(t) {
  const x0 = PAC.L, x1 = PAC.W - PAC.R, y0 = PAC.T, y1 = PAC.H - PAC.B;
  const px = (day) => x0 + (day / DAY_SPAN) * (x1 - x0);
  const py = (pa) => y0 + (1 - pa / 360) * (y1 - y0);

  const samples = new Array(DAY_SPAN + 1);
  for (let i = 0; i <= DAY_SPAN; i++) {
    const d = new Date(YEAR_START.getTime() + i * 86400000);
    const jd = julianDate(d);
    const sun = sunPosition(jd);
    const rep = v3paReport(t.ra, t.dec, sun);
    samples[i] = rep.observable
      ? {
          v3: rep.nominalV3PA,
          apa: rep.nirspecAperturePA,
          marginal: rep.marginal,
          maz: inMAZ(t.ra, t.dec, sun, obliquity(jd)),
        }
      : null;
  }

  // Split each series into three subpath sets: solid (plain observable),
  // dashed (meteoroid unsafe zone), grey (marginal — treated as unavailable).
  // A day-to-day segment takes the "worst" class of its two endpoints.
  const paths = (key) => {
    const d = { norm: "", maz: "", marg: "" };
    const last = { norm: -1, maz: -1, marg: -1 }; // day index last emitted per class
    const pt = (i, v) => `${px(i).toFixed(1)} ${py(v).toFixed(1)}`;
    for (let i = 1; i <= DAY_SPAN; i++) {
      const a = samples[i - 1], b = samples[i];
      if (!a || !b) continue;
      const v0 = a[key], v1 = b[key];
      if (Math.abs(v1 - v0) > 180) continue; // wrap across 0/360
      const cls = a.marginal || b.marginal ? "marg" : a.maz || b.maz ? "maz" : "norm";
      d[cls] += (last[cls] === i - 1 ? "" : `M${pt(i - 1, v0)}`) + `L${pt(i, v1)}`;
      last[cls] = i;
    }
    return d;
  };

  let grid = "";
  for (const pa of [0, 90, 180, 270, 360]) {
    const y = py(pa).toFixed(1);
    grid += `<line class="pac-grid" x1="${x0}" y1="${y}" x2="${x1}" y2="${y}"/>`;
    grid += `<text class="pac-ylab" x="${x0 - 3}" y="${(+y + 2).toFixed(1)}">${pa}</text>`;
  }
  // Quarterly x-axis ticks + tilted YYYY-MM labels (rotated so they can be
  // larger without overlapping in the narrow panel).
  for (const yr of [2027, 2028]) {
    for (const m of [1, 4, 7, 10]) {
      const off = (Date.UTC(yr, m - 1, 1) - YEAR_START.getTime()) / 86400000;
      if (off < 0 || off > DAY_SPAN) continue;
      const xx = px(off).toFixed(1);
      const ly = (y1 + 7).toFixed(1);
      grid += `<line class="pac-grid" x1="${xx}" y1="${y0}" x2="${xx}" y2="${y1}"/>`;
      grid += `<line class="pac-xtick" x1="${xx}" y1="${y1}" x2="${xx}" y2="${(y1 + 2.5).toFixed(1)}"/>`;
      grid += `<text class="pac-xlab" x="${xx}" y="${ly}" transform="rotate(-38 ${xx} ${ly})">${yr}-${String(m).padStart(2, "0")}</text>`;
    }
  }
  const nowX = px(Math.max(0, Math.min(DAY_SPAN, dayOfYear(state.date)))).toFixed(1);
  grid += `<line class="pac-now" x1="${nowX}" y1="${y0}" x2="${nowX}" y2="${y1}"/>`;

  const pv3 = paths("v3"), papa = paths("apa");
  const html =
    `<div class="pac-legend"><span class="pac-key pac-key-v3">V3PA</span>` +
    `<span class="pac-key pac-key-apa">NIRSpec APA</span></div>` +
    `<svg class="pa-chart" viewBox="0 0 ${PAC.W} ${PAC.H}" preserveAspectRatio="xMidYMid meet">` +
    grid +
    `<path class="pac-marg" d="${pv3.marg}"/>` +
    `<path class="pac-marg" d="${papa.marg}"/>` +
    `<path class="pac-v3" d="${pv3.norm}"/>` +
    `<path class="pac-v3 pac-maz" d="${pv3.maz}"/>` +
    `<path class="pac-apa" d="${papa.norm}"/>` +
    `<path class="pac-apa pac-maz" d="${papa.maz}"/>` +
    `<line id="pac-vline" class="pac-vline" y1="${y0}" y2="${y1}" style="display:none"/>` +
    `<circle id="pac-dot-v3" class="pac-dot pac-dot-v3" r="2.6" style="display:none"/>` +
    `<circle id="pac-dot-apa" class="pac-dot pac-dot-apa" r="2.6" style="display:none"/>` +
    `<rect id="pac-hit" x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="transparent"/>` +
    `</svg>`;

  return { html, samples, px, py, x0, x1 };
}

function attachChartHover(chart, t) {
  const svg = document.querySelector(".pa-chart");
  const hit = document.getElementById("pac-hit");
  if (!svg || !hit) return;
  const vline = document.getElementById("pac-vline");
  const dV3 = document.getElementById("pac-dot-v3");
  const dApa = document.getElementById("pac-dot-apa");

  hit.addEventListener("mousemove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const vbx = (ev.clientX - rect.left) * (PAC.W / rect.width); // client px -> viewBox x
    let frac = (vbx - chart.x0) / (chart.x1 - chart.x0);
    frac = Math.max(0, Math.min(1, frac));
    const day = Math.round(frac * DAY_SPAN);
    const s = chart.samples[day];
    const X = chart.px(day);
    vline.setAttribute("x1", X); vline.setAttribute("x2", X); vline.style.display = "block";
    const d = new Date(YEAR_START.getTime() + day * 86400000);

    el.tooltip.hidden = false;
    el.tooltip.style.left = `${ev.clientX + 14}px`;
    el.tooltip.style.top = `${ev.clientY + 14}px`;
    if (s) {
      dV3.setAttribute("cx", X); dV3.setAttribute("cy", chart.py(s.v3)); dV3.style.display = "block";
      dApa.setAttribute("cx", X); dApa.setAttribute("cy", chart.py(s.apa)); dApa.style.display = "block";
      el.tooltip.innerHTML =
        `<b>${fmtWinDate(d)}</b><br>` +
        `V3PA ${fmt(s.v3, 0)}°<br>` +
        `<span class="unit">NIRSpec APA ${fmt(s.apa, 0)}°</span>` +
        (s.marginal ? `<br><span class="warn">marginal — check APT</span>` : "") +
        (s.maz ? `<br><span class="maz">meteoroid unsafe zone</span>` : "");
    } else {
      dV3.style.display = "none"; dApa.style.display = "none";
      el.tooltip.innerHTML = `<b>${fmtWinDate(d)}</b><br><span class="bad">not observable</span>`;
    }
  });
  hit.addEventListener("mouseleave", () => {
    el.tooltip.hidden = true;
    vline.style.display = "none";
    dV3.style.display = "none";
    dApa.style.display = "none";
  });
  hit.addEventListener("click", (ev) => {
    const rect = svg.getBoundingClientRect();
    const vbx = (ev.clientX - rect.left) * (PAC.W / rect.width);
    const frac = Math.max(0, Math.min(1, (vbx - chart.x0) / (chart.x1 - chart.x0)));
    setDateByDay(frac * DAY_SPAN);
  });
}

// The set of position angles the target can be observed at anywhere in the
// span (union of each observable day's V3PA ± roll), plus the matching NIRSpec
// aperture PA. Ranges are circular; an arc like "350°–20°" crosses 0°.
function renderAvailablePA(t) {
  const pa = availablePA(t.ra, t.dec, YEAR_START, DAY_SPAN + 1);
  if (!pa.any) return "";
  const arcs = (list) =>
    pa.full
      ? "all angles"
      : list.map((a) => `${fmt(a.min, 0)}°–${fmt(a.max, 0)}°`).join(", ");
  return (
    `<div class="win-title">Available PA (2027–2028)</div>` +
    `<div class="win"><span>V3PA</span><span class="unit">${arcs(pa.v3pa)}</span></div>` +
    `<div class="win"><span>NIRSpec aperture PA</span><span class="unit">${arcs(pa.nirspec)}</span></div>`
  );
}

function row(label, value) {
  return `<tr><td class="label">${label}</td><td class="value">${value}</td></tr>`;
}

// ---------------------------------------------------------------------------
// Master render: recompute Sun, push to scene, refresh readouts.
// ---------------------------------------------------------------------------
function render() {
  const jd = julianDate(state.date);
  const sun = sunPosition(jd);
  scene.setEcliptic(buildEclipticSamples(jd));
  const poles = cvzPoles(jd);
  scene.setCVZ(poles.north, poles.south);
  scene.setSun(sun.ra, sun.dec, ramDirection(sun, obliquity(jd)));
  updateTargetMarker();
  renderTargetReadout();
}

// ---------------------------------------------------------------------------
// Control wiring
// ---------------------------------------------------------------------------
el.dateInput.addEventListener("change", () => {
  const parts = el.dateInput.value.split("-").map(Number);
  if (parts.length === 3 && parts.every(Number.isFinite)) {
    state.date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    syncDateControls();
    render();
  }
});

el.daySlider.addEventListener("input", () => {
  const day = Number(el.daySlider.value);
  state.date = new Date(YEAR_START.getTime() + day * 86400000);
  syncDateControls();
  render();
});

el.lookupBtn.addEventListener("click", () => {
  const ra = Number(el.raInput.value);
  const dec = Number(el.decInput.value);
  if (Number.isFinite(ra) && Number.isFinite(dec) && dec >= -90 && dec <= 90) {
    pinTarget(ra, dec);
  }
});

el.clearBtn.addEventListener("click", clearTarget);

// Toggle the classic-field markers on/off (checked = shown, on by default).
el.fieldsCheck.addEventListener("change", () => {
  scene.setFieldsVisible(el.fieldsCheck.checked);
});

// Toggle the meteoroid-zone overlay on the sphere (unchecked = off by default).
el.mazCheck.addEventListener("change", () => {
  scene.setMAZVisible(el.mazCheck.checked);
});

// Hide the tooltip when the pointer leaves the canvas.
el.canvas.addEventListener("pointerleave", () => {
  el.tooltip.hidden = true;
  state.hover = null;
  if (!state.target) renderTargetReadout();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
syncDateControls();
pinTarget(53, -27.8); // default target: GOODS-South / CDF-S field
render();
// Signal the classic guard in index.html that the module loaded successfully.
window.__jwstBooted = true;
