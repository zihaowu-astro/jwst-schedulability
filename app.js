"use strict";

// ===========================================================================
// app.js — controller. Owns the single source of truth (current date + active
// target), wires the DOM controls and the 3D scene together, and writes the
// readout. All maths comes from astro.js; all rendering from sphere.js.
// ===========================================================================

import {
  julianDate, sunPosition, obliquity,
  eclipticToRaDec, v3paReport, inCVZ, visibilityWindows,
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
// Slider spans Jan 1 2027 -> Aug 31 2028 (inclusive).
const DAY_SPAN = 608;

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
  fieldsBtn: document.getElementById("fields-btn"),
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
  scene.setTarget(state.target.ra, state.target.dec, rep.observable);
}

function onHover(rd, ev, field) {
  state.hover = rd;
  if (rd && !state.target) {
    // Live readout for the hovered point when nothing is pinned.
    renderTargetReadout();
  }
  // Floating tooltip near the cursor with the essentials.
  if (rd) {
    const sun = sunPosition(julianDate(state.date));
    // Over a classic field, describe that field (using its own coordinates);
    // otherwise report the cursor point.
    const p = field || rd;
    const rep = v3paReport(p.ra, p.dec, sun);
    el.tooltip.hidden = false;
    el.tooltip.style.left = `${ev.clientX + 14}px`;
    el.tooltip.style.top = `${ev.clientY + 14}px`;
    const obs = rep.observable
      ? `V3PA ${fmt(rep.nominalV3PA, 1)}°`
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

  el.targetTitle.textContent = state.target
    ? `Target (pinned)`
    : `Target (hover)`;

  let obsCell = rep.observable
    ? `<span class="good">Yes</span>`
    : `<span class="bad">No</span>`;
  if (cvz) obsCell += ` <span class="unit">· CVZ (year-round)</span>`;

  el.targetReadout.innerHTML =
    row("RA", `${fmt(t.ra, 3)}° <span class="unit">(${raToHMS(t.ra)})</span>`) +
    row("Dec", `${fmt(t.dec, 3)}°`) +
    row("Solar elongation", `${fmt(rep.elongation, 2)}°`) +
    row("Observable now", obsCell) +
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
  if (wins.length === 0) {
    el.windows.innerHTML = `<div class="win-none">No visibility in the reference year.</div>`;
    return;
  }
  const rows = wins
    .map((w) => {
      const s = w.start.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
      const e = w.end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
      return `<div class="win"><span>${s} – ${e}</span><span class="unit">${w.days} d</span></div>`;
    })
    .join("");
  el.windows.innerHTML = `<div class="win-title">Visibility windows (2027–2028)</div>${rows}`;
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
  scene.setSun(sun.ra, sun.dec);
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

// Toggle the classic-field markers on/off.
let fieldsVisible = true;
el.fieldsBtn.addEventListener("click", () => {
  fieldsVisible = !fieldsVisible;
  scene.setFieldsVisible(fieldsVisible);
  el.fieldsBtn.textContent = fieldsVisible ? "Hide classic fields" : "Show classic fields";
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
