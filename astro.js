"use strict";

// ===========================================================================
// astro.js — pure astronomy for the JWST field-of-regard tool.
//
// No dependencies, no DOM. Every function here is unit-testable in isolation.
// Angles are handled in RADIANS internally; RA/Dec are exposed in DEGREES at
// the module boundary (callers think in degrees, the math stays in radians).
// ===========================================================================

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const DEG = Math.PI / 180;            // degrees -> radians
export const RAD = 180 / Math.PI;            // radians -> degrees
export const J2000 = 2451545.0;              // JD of the J2000.0 epoch

// JWST field of regard: allowed solar-elongation band [degrees].
// The sunshield keeps the boresight between 85 and 135 deg from the Sun.
export const FOR_MIN = 85;
export const FOR_MAX = 135;

// Allowed roll (V3PA) half-width about Normal Roll, interpolated with
// elongation: +/-3 deg at 85 deg elongation, +/-7 deg at 135 deg (STScI).
export const ROLL_AT_MIN = 3;
export const ROLL_AT_MAX = 7;

// Fuzzy band [degrees] inside each FOR edge where observability is flagged
// "marginal". We compute elongation from the geocentric Sun, but the real
// pitch constraint applies at JWST's L2 halo orbit (radius up to ~800,000 km),
// where the apparent Sun direction can differ from geocentric by up to ~0.3
// deg — enough to flip in/out for targets grazing the 85/135 limits (i.e.
// |ecliptic latitude| near 45 or 40 deg). The band is wider than that parallax
// alone because APT also applies scheduling margins near the edges (comparing
// against APT for a 135-grazing target showed its unobservable gap extending a
// few days past the 0.3-deg band). APT/jwst_gtvt are authoritative.
export const FOR_MARGIN = 0.8;

// Continuous Viewing Zone: |ecliptic latitude| >= this is visible year-round
// (5 deg cap around each ecliptic pole). See cvzLatitude() derivation below.
export const CVZ_LAT = 85;

// Micrometeoroid avoidance zone (Cycle 2+): a cone of this half-angle around
// the ram vector (JWST's orbital-motion direction). Soft constraint — APT only
// warns (visits >70% in-MAZ need a justification), observing there is not
// forbidden. Note: JDox pages disagree ("half angle ... 75 deg" vs "cone of
// diameter 75 degrees"); the half-angle reading is the one consistent with the
// same page's claim that the MAZ covers the entire leading FOR within 45 deg
// of the ecliptic (a 37.5 deg half-angle could not).
export const MAZ_HALF_ANGLE = 75;

// NIRSpec aperture orientation. Its Ideal-frame Y axis is rotated 138.5 deg
// (counter-clockwise from +V3) relative to the V3 axis (STScI SIAF / NIRSpec
// is the one instrument with a large V3IdlYAngle offset). The on-sky aperture
// position angle is then APA = V3PA + V3IdlYAngle.
export const NIRSPEC_V3IDLYANGLE = 138.5;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Reduce an angle in degrees to [0, 360).
export function mod360(deg) {
  return ((deg % 360) + 360) % 360;
}

// Reduce an angle in radians to [0, 2*pi).
function mod2pi(rad) {
  const t = Math.PI * 2;
  return ((rad % t) + t) % t;
}

// ---------------------------------------------------------------------------
// Time: calendar date -> Julian Date
// ---------------------------------------------------------------------------

// Julian Date for a JS Date, using its UTC fields. Fliegel-Van Flandern for
// the integer day count plus the UTC time of day as a fraction.
export function julianDate(date) {
  const Y = date.getUTCFullYear();
  const M = date.getUTCMonth() + 1;
  const D = date.getUTCDate();
  const a = Math.floor((14 - M) / 12);
  const y = Y + 4800 - a;
  const m = M + 12 * a - 3;
  const jdn =
    D +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045;
  const dayFrac =
    (date.getUTCHours() - 12) / 24 +
    date.getUTCMinutes() / 1440 +
    date.getUTCSeconds() / 86400;
  return jdn + dayFrac;
}

// ---------------------------------------------------------------------------
// Sun apparent position (low-precision USNO formula, accurate to ~0.01 deg,
// far better than the FOR needs). Returns {ra, dec, eclipticLon} in degrees.
// The Sun seen from JWST at L2 matches the geocentric Sun to well within the
// FOR tolerance, so we use the geocentric apparent position.
// ---------------------------------------------------------------------------
export function sunPosition(jd) {
  const n = jd - J2000;                          // days from J2000.0
  const L = mod360(280.460 + 0.9856474 * n);     // mean longitude [deg]
  const g = mod360(357.528 + 0.9856003 * n) * DEG; // mean anomaly [rad]
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG; // ecliptic lon [rad]
  const eps = (23.439 - 4e-7 * n) * DEG;         // obliquity [rad]
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  return {
    ra: mod360(ra * RAD),
    dec: dec * RAD,
    eclipticLon: mod360(lambda * RAD),
  };
}

// Obliquity of the ecliptic [radians] at a given JD.
export function obliquity(jd) {
  return (23.439 - 4e-7 * (jd - J2000)) * DEG;
}

// ---------------------------------------------------------------------------
// Geometry on the sphere
// ---------------------------------------------------------------------------

// Angular separation (solar elongation) between two RA/Dec points [degrees].
export function angularSeparation(ra1, dec1, ra2, dec2) {
  const a1 = ra1 * DEG, d1 = dec1 * DEG;
  const a2 = ra2 * DEG, d2 = dec2 * DEG;
  const cosE =
    Math.sin(d1) * Math.sin(d2) +
    Math.cos(d1) * Math.cos(d2) * Math.cos(a1 - a2);
  // Clamp against round-off before acos.
  return Math.acos(Math.max(-1, Math.min(1, cosE))) * RAD;
}

// Solar elongation of a target given the Sun position [degrees].
export function elongation(targetRa, targetDec, sun) {
  return angularSeparation(targetRa, targetDec, sun.ra, sun.dec);
}

// Is a target observable right now? (elongation within the FOR band)
export function isObservable(elong) {
  return elong >= FOR_MIN && elong <= FOR_MAX;
}

// Observable, but within FOR_MARGIN of an FOR edge — where this tool's
// geocentric-Sun approximation can disagree with APT (see FOR_MARGIN above).
export function isMarginal(elong) {
  return (
    isObservable(elong) &&
    (elong < FOR_MIN + FOR_MARGIN || elong > FOR_MAX - FOR_MARGIN)
  );
}

// ---------------------------------------------------------------------------
// JWST Normal Roll: nominal V3 position angle and allowed roll range.
//
// Normal Roll keeps the Sun in the V1-V3 plane on the sunshield (-V3) side, so
// the +V3 axis points away from the Sun. The V3 position angle (N through E at
// the target) is therefore the bearing to the Sun, plus 180 deg.
// ---------------------------------------------------------------------------

// Position angle (N->E, degrees) of the Sun as seen from the target.
export function positionAngleToSun(targetRa, targetDec, sun) {
  const at = targetRa * DEG, dt = targetDec * DEG;
  const as = sun.ra * DEG, ds = sun.dec * DEG;
  const dAlpha = as - at;
  const y = Math.cos(ds) * Math.sin(dAlpha);
  const x = Math.sin(ds) * Math.cos(dt) - Math.cos(ds) * Math.sin(dt) * Math.cos(dAlpha);
  return mod360(Math.atan2(y, x) * RAD);
}

// Nominal V3 position angle (Normal Roll) [degrees].
export function nominalV3PA(targetRa, targetDec, sun) {
  return mod360(positionAngleToSun(targetRa, targetDec, sun) + 180);
}

// Allowed roll half-width [degrees] as a function of elongation, linearly
// interpolated between the endpoints and clamped to the FOR band.
export function rollHalfWidth(elong) {
  const e = Math.max(FOR_MIN, Math.min(FOR_MAX, elong));
  const f = (e - FOR_MIN) / (FOR_MAX - FOR_MIN);
  return ROLL_AT_MIN + f * (ROLL_AT_MAX - ROLL_AT_MIN);
}

// Full V3PA report for a target on a given date: nominal PA, allowed range,
// elongation and observability. Returns null fields when out of the FOR band.
export function v3paReport(targetRa, targetDec, sun) {
  const elong = elongation(targetRa, targetDec, sun);
  const observable = isObservable(elong);
  const nominal = nominalV3PA(targetRa, targetDec, sun);
  const half = rollHalfWidth(elong);
  return {
    elongation: elong,
    observable,
    marginal: isMarginal(elong),
    nominalV3PA: nominal,
    rollHalfWidth: half,
    v3paMin: mod360(nominal - half),
    v3paMax: mod360(nominal + half),
    // NIRSpec aperture position angle (APA = V3PA + V3IdlYAngle) and its range.
    nirspecAperturePA: mod360(nominal + NIRSPEC_V3IDLYANGLE),
    nirspecPAMin: mod360(nominal - half + NIRSPEC_V3IDLYANGLE),
    nirspecPAMax: mod360(nominal + half + NIRSPEC_V3IDLYANGLE),
  };
}

// ---------------------------------------------------------------------------
// Ecliptic <-> equatorial conversion (rotation by the obliquity eps).
// Both directions take/return degrees. eps is in radians.
// ---------------------------------------------------------------------------

// Equatorial (ra, dec) -> ecliptic (lon, lat), degrees.
export function raDecToEcliptic(ra, dec, eps) {
  const a = ra * DEG, d = dec * DEG;
  const sinB = Math.sin(d) * Math.cos(eps) - Math.cos(d) * Math.sin(eps) * Math.sin(a);
  const lat = Math.asin(Math.max(-1, Math.min(1, sinB)));
  const y = Math.sin(a) * Math.cos(eps) + Math.tan(d) * Math.sin(eps);
  const x = Math.cos(a);
  const lon = Math.atan2(y, x);
  return { lon: mod360(lon * RAD), lat: lat * RAD };
}

// Ecliptic (lon, lat) -> equatorial (ra, dec), degrees.
export function eclipticToRaDec(lon, lat, eps) {
  const l = lon * DEG, b = lat * DEG;
  const sinD = Math.sin(b) * Math.cos(eps) + Math.cos(b) * Math.sin(eps) * Math.sin(l);
  const dec = Math.asin(Math.max(-1, Math.min(1, sinD)));
  const y = Math.sin(l) * Math.cos(eps) - Math.tan(b) * Math.sin(eps);
  const x = Math.cos(l);
  const ra = Math.atan2(y, x);
  return { ra: mod360(ra * RAD), dec: dec * RAD };
}

// ---------------------------------------------------------------------------
// Micrometeoroid avoidance zone.
//
// JWST shares Earth's heliocentric orbit at L2, so its velocity points 90 deg
// west of the Sun along the ecliptic (the "apex of the Earth's way"): ecliptic
// longitude lambda_sun - 90, latitude 0. That apex sits at solar elongation 90,
// i.e. inside the FOR band — the MAZ is the orbit-leading part of the annulus.
// ---------------------------------------------------------------------------

// Ram vector (orbital-motion apex) as {ra, dec} in degrees.
export function ramDirection(sun, eps) {
  return eclipticToRaDec(mod360(sun.eclipticLon - 90), 0, eps);
}

// Is a target inside the micrometeoroid avoidance zone on this date?
export function inMAZ(targetRa, targetDec, sun, eps) {
  const ram = ramDirection(sun, eps);
  return angularSeparation(targetRa, targetDec, ram.ra, ram.dec) <= MAZ_HALF_ANGLE;
}

// ---------------------------------------------------------------------------
// Continuous Viewing Zone
//
// A target at ecliptic latitude b sees the Sun sweep all ecliptic longitudes
// over a year. With the Sun on the ecliptic (lat 0), the separation obeys
//   cos e = cos b * cos(dLon),
// so over the year e ranges over [|b|, 180 - |b|]. Requiring that whole range
// to sit inside [85, 135] gives |b| >= 85 deg -> a 5 deg cap at each pole.
// ---------------------------------------------------------------------------
export function inCVZ(targetRa, targetDec, jd) {
  const ecl = raDecToEcliptic(targetRa, targetDec, obliquity(jd));
  return Math.abs(ecl.lat) >= CVZ_LAT;
}

// ---------------------------------------------------------------------------
// Annual visibility windows.
//
// Step day-by-day over `days` starting at `startDate`, and collect the
// contiguous runs where the target is observable. Returns an array of
// { start: Date, end: Date, days: n } (end is the last observable day).
// ---------------------------------------------------------------------------
export function visibilityWindows(targetRa, targetDec, startDate, days = 366) {
  const windows = [];
  let run = null;
  const dayMs = 86400000;
  const t0 = startDate.getTime();

  for (let i = 0; i < days; i++) {
    const d = new Date(t0 + i * dayMs);
    const sun = sunPosition(julianDate(d));
    const observable = isObservable(elongation(targetRa, targetDec, sun));
    if (observable) {
      if (!run) run = { start: d, end: d, days: 1 };
      else { run.end = d; run.days++; }
    } else if (run) {
      windows.push(run);
      run = null;
    }
  }
  if (run) windows.push(run);
  return windows;
}

// ---------------------------------------------------------------------------
// Available position angles over the whole span.
//
// As the observing date moves through the visibility windows, the nominal
// V3PA (plus its allowed roll half-width) sweeps out a set of achievable
// position angles. Because PA is circular, we accumulate a 1-deg coverage map
// over every observable day and then read off the contiguous arcs. NIRSpec's
// aperture PA is just the V3PA arcs rigidly shifted by +V3IdlYAngle.
//
// Returns { any, full, v3pa: [{min,max}], nirspec: [{min,max}] } with angles in
// degrees; an arc with min > max (after wrapping) crosses 0°. `full` means the
// target can be observed at every position angle across the span.
// ---------------------------------------------------------------------------
export function availablePA(targetRa, targetDec, startDate, days = 366) {
  const cov = new Array(360).fill(false);
  let any = false;
  const dayMs = 86400000;
  const t0 = startDate.getTime();

  for (let i = 0; i < days; i++) {
    const d = new Date(t0 + i * dayMs);
    const sun = sunPosition(julianDate(d));
    const rep = v3paReport(targetRa, targetDec, sun);
    if (!rep.observable) continue;
    any = true;
    const lo = Math.round(rep.nominalV3PA - rep.rollHalfWidth);
    const hi = Math.round(rep.nominalV3PA + rep.rollHalfWidth);
    for (let k = lo; k <= hi; k++) cov[((k % 360) + 360) % 360] = true;
  }

  const arcs = coverageToArcs(cov);
  if (!any) return { any: false, full: false, v3pa: [], nirspec: [] };
  if (arcs === "full") return { any: true, full: true, v3pa: [], nirspec: [] };
  const v3pa = arcs.map((a) => ({ min: mod360(a.min), max: mod360(a.max) }));
  const nirspec = arcs.map((a) => ({
    min: mod360(a.min + NIRSPEC_V3IDLYANGLE),
    max: mod360(a.max + NIRSPEC_V3IDLYANGLE),
  }));
  return { any: true, full: false, v3pa, nirspec };
}

// Read contiguous arcs out of a 360-bin boolean coverage map. Returns "full"
// when every bin is set, [] when none are, else [{min,max}] where max = min +
// width (not yet wrapped, so a seam-crossing arc stays contiguous). Scanning
// starts just after a gap so no arc is split across the 359°->0° seam.
function coverageToArcs(cov) {
  const n = cov.length;
  let count = 0;
  for (const b of cov) if (b) count++;
  if (count === 0) return [];
  if (count === n) return "full";

  let gap = 0;
  while (cov[gap]) gap++; // first uncovered bin

  const arcs = [];
  let cur = null;
  for (let step = 1; step <= n; step++) {
    const idx = (gap + step) % n;
    if (cov[idx]) {
      if (!cur) cur = { min: gap + step, len: 1 };
      else cur.len++;
    } else if (cur) {
      arcs.push({ min: cur.min, max: cur.min + cur.len });
      cur = null;
    }
  }
  if (cur) arcs.push({ min: cur.min, max: cur.min + cur.len });
  return arcs;
}
