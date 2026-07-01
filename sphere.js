"use strict";

// ===========================================================================
// sphere.js — the interactive 3D celestial sphere (Three.js).
//
// Renders an RA/Dec globe, the ecliptic ring (the Sun's annual path), a Sun
// marker, the glowing field-of-regard band, the Continuous Viewing Zone caps,
// and a movable target marker. Handles pointer picking (hover -> RA/Dec, click
// on the ecliptic ring -> ecliptic longitude). All astronomy lives in app.js;
// this module only knows geometry and rendering.
// ===========================================================================

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DEG, RAD, FOR_MIN, FOR_MAX } from "./astro.js";

const R = 1; // celestial-sphere radius

// (ra, dec) in degrees -> unit vector on the sphere.
// x = cos d cos a, y = cos d sin a, z = sin d.
function raDecToVec(ra, dec, radius = R) {
  const a = ra * DEG, d = dec * DEG;
  return new THREE.Vector3(
    radius * Math.cos(d) * Math.cos(a),
    radius * Math.cos(d) * Math.sin(a),
    radius * Math.sin(d)
  );
}

// Unit vector -> {ra, dec} in degrees.
function vecToRaDec(v) {
  const r = v.length();
  const dec = Math.asin(v.z / r) * RAD;
  let ra = Math.atan2(v.y, v.x) * RAD;
  if (ra < 0) ra += 360;
  return { ra, dec };
}

export function createSphere(container, callbacks = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.up.set(0, 0, 1);            // north celestial pole (+z) points up
  camera.position.set(2.9, 1.4, 1.3);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.rotateSpeed = 0.5;
  controls.minDistance = 1.5;
  controls.maxDistance = 6;
  // Allow spin around the celestial pole (RA / longitude) and zoom, but lock the
  // polar tilt so declination cannot be rotated.
  controls.update();
  const lockedPolar = controls.getPolarAngle();
  controls.minPolarAngle = lockedPolar;
  controls.maxPolarAngle = lockedPolar;

  scene.add(new THREE.AmbientLight(0xffffff, 0.9));

  // ---- Base sphere: a faint glass globe + the pick surface for hover ------
  const sphereGeom = new THREE.SphereGeometry(R * 0.999, 96, 64);
  const sphereMat = new THREE.MeshBasicMaterial({
    color: 0xeef1f5,        // faint globe on the white background
    transparent: true,
    opacity: 0.18,          // glassy, see-through celestial sphere
    side: THREE.DoubleSide,
    depthWrite: false,      // don't let the glass occlude grid/markers behind it
  });
  const sphereMesh = new THREE.Mesh(sphereGeom, sphereMat);
  scene.add(sphereMesh);

  // ---- Graticule: RA/Dec grid lines ---------------------------------------
  const grid = new THREE.Group();
  const gridMat = new THREE.LineBasicMaterial({ color: 0xb7c0cd, transparent: true, opacity: 0.9 });
  const equatorMat = new THREE.LineBasicMaterial({ color: 0x7c8797 });
  // A few parallels (constant declination) — equator plus ±30°, ±60°.
  for (const dec of [-60, -30, 0, 30, 60]) {
    const pts = [];
    for (let ra = 0; ra <= 360; ra += 3) pts.push(raDecToVec(ra, dec, R * 1.001));
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      dec === 0 ? equatorMat : gridMat
    );
    grid.add(line);
  }
  // A few meridians (every 90°: 0h, 6h, 12h, 18h) so the globe reads cleanly.
  for (let ra = 0; ra < 360; ra += 90) {
    const pts = [];
    for (let dec = -90; dec <= 90; dec += 3) pts.push(raDecToVec(ra, dec, R * 1.001));
    grid.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gridMat));
  }
  scene.add(grid);

  // ---- Axis labels (RA hours + Dec) via sprites ---------------------------
  const labelGroup = new THREE.Group();
  // Text sprites kept at a constant on-screen size, independent of depth and
  // zoom: the canvas is sized to the text (fixed, non-bold font) and the world
  // scale is refreshed every frame from the camera distance (see animate). So a
  // near or far label is the same size, and short/long strings share one glyph
  // size. `frac` is the target label height as a fraction of the viewport.
  const LABEL_FONT = "30px 'Helvetica Neue', Arial, sans-serif"; // sans-serif so 0 ≠ o, not bold
  const LABEL_CANVAS_H = 48;
  const screenLabels = [];
  function makeLabel(text, color = "#31384a", frac = 0.036) {
    const meas = document.createElement("canvas").getContext("2d");
    meas.font = LABEL_FONT;
    const pad = 10;
    const w = Math.max(16, Math.ceil(meas.measureText(text).width) + pad * 2);
    const c = document.createElement("canvas");
    c.width = w; c.height = LABEL_CANVAS_H;
    const ctx = c.getContext("2d");
    ctx.font = LABEL_FONT;
    ctx.fillStyle = "#ffffff"; // white glyphs; the sprite material tints them
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, w / 2, LABEL_CANVAS_H / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, color: new THREE.Color(color), transparent: true, depthTest: false,
    }));
    spr.userData.frac = frac;
    spr.userData.aspect = w / LABEL_CANVAS_H;
    screenLabels.push(spr);
    return spr;
  }
  for (let h = 0; h < 24; h += 6) {
    const spr = makeLabel(`${h}h`, "#9aa3b2", 0.027);
    spr.position.copy(raDecToVec(h * 15, 0, R * 1.035));
    labelGroup.add(spr);
  }
  const decLabels = [];
  for (const dec of [-60, -30, 30, 60]) {
    const spr = makeLabel(`${dec > 0 ? "+" : ""}${dec}°`, "#9aa3b2", 0.027);
    spr.userData.pinned = true; // held on the sphere's left edge, not rotating
    labelGroup.add(spr);
    decLabels.push({ spr, dec });
  }
  scene.add(labelGroup);

  // ---- Classic deep/survey fields -----------------------------------------
  // Well-known extragalactic fields, fixed in RA/Dec (approx. centres).
  const FIELDS = [
    { name: "GOODS-S", ra: 53.12, dec: -27.80,
      desc: "GOODS-South / CDF-S — premier deep multiwavelength field (GOODS, CANDELS, JADES)." },
    { name: "GOODS-N", ra: 189.23, dec: 62.24,
      desc: "GOODS-North, around the Hubble Deep Field — deep HST/JWST imaging & spectroscopy." },
    { name: "COSMOS", ra: 150.12, dec: 2.21,
      desc: "Cosmic Evolution Survey — 2 deg² equatorial field for large-scale structure & galaxy evolution." },
    { name: "NEXUS", ra: 269.73, dec: 66.02,
      desc: "JWST NEXUS deep time-domain survey near the North Ecliptic Pole." },
    { name: "Abell 2744", ra: 3.59, dec: -30.39,
      desc: "Pandora's Cluster — massive lensing cluster (Frontier Fields, UNCOVER)." },
    { name: "EGS", ra: 214.80, dec: 52.80,
      desc: "Extended Groth Strip — CANDELS / CEERS deep field." },
    { name: "UDS", ra: 34.45, dec: -5.20,
      desc: "UKIDSS Ultra Deep Survey — near-IR deep field (CANDELS, PRIMER)." },
    { name: "SMACS 0723", ra: 110.83, dec: -73.45,
      desc: "Lensing cluster of JWST's first deep field (Early Release Observations)." },
  ];
  const fieldGroup = new THREE.Group();
  const fieldDots = []; // { mesh, dir } — recoloured by observability each date
  for (const f of FIELDS) {
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.012, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x9096a0 }) // grey until shown observable
    );
    dot.position.copy(raDecToVec(f.ra, f.dec, R * 1.01));
    fieldGroup.add(dot);
    const lbl = makeLabel(f.name, "#5a6270", 0.034);
    lbl.position.copy(raDecToVec(f.ra, f.dec, R * 1.12));
    fieldGroup.add(lbl);
    fieldDots.push({ mesh: dot, label: lbl, dir: raDecToVec(f.ra, f.dec).normalize() });
  }
  scene.add(fieldGroup);

  // ---- Ecliptic ring (Sun's annual path) ----------------------------------
  // Built from ecliptic-longitude samples supplied by app.js as RA/Dec points.
  let eclipticRing = null;
  let eclipticSamples = []; // [{lon, ra, dec, vec}]
  function setEcliptic(samples) {
    eclipticSamples = samples.map((s) => ({ ...s, vec: raDecToVec(s.ra, s.dec, R * 1.004) }));
    if (eclipticRing) { scene.remove(eclipticRing); eclipticRing.geometry.dispose(); }
    const curve = new THREE.CatmullRomCurve3(eclipticSamples.map((s) => s.vec), true);
    const geom = new THREE.TubeGeometry(curve, 400, 0.006, 8, true);
    eclipticRing = new THREE.Mesh(
      geom,
      new THREE.MeshBasicMaterial({ color: 0xd9a441 })
    );
    scene.add(eclipticRing);
  }

  // ---- Sun marker ----------------------------------------------------------
  const sunMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0xf5a300 })
  );
  const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialSprite("#ffb42e"), transparent: true, depthWrite: false, opacity: 0.6,
  }));
  sunGlow.scale.set(0.28, 0.28, 1);
  sunMarker.add(sunGlow);
  scene.add(sunMarker);

  // ---- Target marker (from lookup or hover pin) ----------------------------
  const targetMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.022, 20, 14),
    new THREE.MeshBasicMaterial({ color: 0xa4322a })
  );
  targetMarker.visible = false;
  scene.add(targetMarker);

  // ---- Hover marker (transient) -------------------------------------------
  const hoverMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.016, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x1f4e79 })
  );
  hoverMarker.visible = false;
  scene.add(hoverMarker);

  // ---- CVZ caps (two 5-deg caps at the ecliptic poles) --------------------
  let cvzGroup = null;
  function setCVZ(northPole, southPole) {
    if (cvzGroup) { scene.remove(cvzGroup); }
    cvzGroup = new THREE.Group();
    for (const p of [northPole, southPole]) {
      // Small filled cap: a thin cone-less disk approximated by a circle ring.
      const pts = [];
      const center = raDecToVec(p.ra, p.dec, R * 1.002);
      // Build a ring at 5 deg radius around the pole direction.
      const axis = center.clone().normalize();
      const ref = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
      const u = new THREE.Vector3().crossVectors(axis, ref).normalize();
      const w = new THREE.Vector3().crossVectors(axis, u).normalize();
      const capAngle = 5 * DEG;
      for (let t = 0; t <= 360; t += 6) {
        const ang = t * DEG;
        const dir = axis.clone().multiplyScalar(Math.cos(capAngle))
          .add(u.clone().multiplyScalar(Math.sin(capAngle) * Math.cos(ang)))
          .add(w.clone().multiplyScalar(Math.sin(capAngle) * Math.sin(ang)));
        pts.push(dir.multiplyScalar(R * 1.003));
      }
      const ring = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x5aa9e6 })
      );
      cvzGroup.add(ring);
    }
    scene.add(cvzGroup);
  }

  // ---- Field of regard: the two boundary circles around the Sun -----------
  // JWST can point 85°–135° from the Sun, so the FOR is bounded by two small
  // circles of constant solar elongation. We draw each as a circle on the
  // sphere, recomputed whenever the Sun (date) moves.
  let sunDir = new THREE.Vector3(1, 0, 0);
  let forGroup = null;
  const FOR_LINE_MAT = new THREE.LineBasicMaterial({ color: 0x1f8a5b }); // observable-edge green
  const FOR_FILL_MAT = new THREE.MeshBasicMaterial({
    color: 0x37b07a, transparent: true, opacity: 0.18,
    side: THREE.DoubleSide, depthWrite: false,
  }); // shaded observable band

  // Orthonormal basis (u, w) perpendicular to a unit axis.
  function perpBasis(axis) {
    const ref = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(axis, ref).normalize();
    const w = new THREE.Vector3().crossVectors(axis, u).normalize();
    return { u, w };
  }
  // Direction at solar elongation `e` (rad) and position angle `ang` (rad).
  function elongDir(axis, u, w, e, ang, radius) {
    return axis.clone().multiplyScalar(Math.cos(e))
      .add(u.clone().multiplyScalar(Math.sin(e) * Math.cos(ang)))
      .add(w.clone().multiplyScalar(Math.sin(e) * Math.sin(ang)))
      .multiplyScalar(radius);
  }

  // A circle of constant solar elongation `elongDeg` around the Sun direction.
  function elongationCircle(axis, u, w, elongDeg) {
    const e = elongDeg * DEG;
    const pts = [];
    for (let t = 0; t <= 360; t += 2) pts.push(elongDir(axis, u, w, e, t * DEG, R * 1.006));
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), FOR_LINE_MAT);
  }

  // Filled band (annulus lying ON the sphere) between two elongations — the
  // shaded FOR. Subdivided radially (across the band) as well as around, so the
  // surface hugs the sphere instead of forming a cone/funnel through it.
  function elongationBand(axis, u, w, e1Deg, e2Deg) {
    const e1 = e1Deg * DEG, e2 = e2Deg * DEG;
    const N = 180, M = 24, rad = R * 1.004; // N around, M across the band
    const stride = N + 1;
    const pos = [], idx = [];
    for (let j = 0; j <= M; j++) {
      const e = e1 + (e2 - e1) * (j / M);
      for (let i = 0; i <= N; i++) {
        const d = elongDir(axis, u, w, e, (i / N) * Math.PI * 2, rad);
        pos.push(d.x, d.y, d.z);
      }
    }
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * stride + i, b = a + 1, c = a + stride, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return new THREE.Mesh(g, FOR_FILL_MAT);
  }

  function drawFOR() {
    if (forGroup) {
      scene.remove(forGroup);
      forGroup.traverse((o) => o.geometry && o.geometry.dispose());
    }
    forGroup = new THREE.Group();
    const axis = sunDir.clone().normalize();
    const { u, w } = perpBasis(axis);
    forGroup.add(elongationBand(axis, u, w, FOR_MIN, FOR_MAX)); // shaded band
    forGroup.add(elongationCircle(axis, u, w, FOR_MIN));        // inner edge (85°)
    forGroup.add(elongationCircle(axis, u, w, FOR_MAX));        // outer edge (135°)
    scene.add(forGroup);
  }

  // Recolour the classic fields: green if inside the FOR (observable now),
  // grey otherwise. Uses the same dot-product test as the FOR band.
  const C_FIELD_ON = new THREE.Color(0x0f9d58);    // observable (green)
  const C_FIELD_OFF = new THREE.Color(0x9096a0);   // dot: not observable (grey)
  const C_FIELD_LBL_OFF = new THREE.Color(0x5a6270); // label: not observable (grey)
  function updateFieldColors() {
    const cosMin = Math.cos(FOR_MAX * DEG); // 135° edge
    const cosMax = Math.cos(FOR_MIN * DEG); // 85° edge
    for (const f of fieldDots) {
      const cosE = f.dir.dot(sunDir);
      const obs = cosE <= cosMax && cosE >= cosMin;
      f.mesh.material.color.copy(obs ? C_FIELD_ON : C_FIELD_OFF);
      f.label.material.color.copy(obs ? C_FIELD_ON : C_FIELD_LBL_OFF);
    }
  }

  // ---- Public updates ------------------------------------------------------
  function setSun(ra, dec) {
    sunMarker.position.copy(raDecToVec(ra, dec, R * 1.01));
    sunDir = raDecToVec(ra, dec).normalize();
    drawFOR();
    updateFieldColors();
  }
  function setTarget(ra, dec, observable = true) {
    if (ra == null) { targetMarker.visible = false; return; }
    targetMarker.position.copy(raDecToVec(ra, dec, R * 1.01));
    targetMarker.material.color.set(observable ? 0x0f9d58 : 0xd42a1f); // green if observable, else red
    targetMarker.visible = true;
  }

  // ---- Pointer picking -----------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let lastHover = null;

  function pointerToNDC(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  }

  // Nearest classic field to a picked point, if within ~4° (and fields shown).
  const HOVER_FIELD_TOL = Math.cos(4 * DEG);
  function nearestField(point) {
    if (!fieldGroup.visible) return null;
    const p = point.clone().normalize();
    let best = null, bestDot = HOVER_FIELD_TOL;
    for (let i = 0; i < FIELDS.length; i++) {
      const d = p.dot(fieldDots[i].dir);
      if (d > bestDot) { bestDot = d; best = FIELDS[i]; }
    }
    return best;
  }

  // Field directly under the cursor — a dot or its text label. Lets the user
  // hover the label (which sits off the sphere surface), not just the point.
  function fieldUnderPointer() {
    if (!fieldGroup.visible) return null;
    const pickables = [];
    for (const fd of fieldDots) { pickables.push(fd.mesh, fd.label); }
    const hits = raycaster.intersectObjects(pickables, false);
    if (!hits.length) return null;
    const obj = hits[0].object;
    const fd = fieldDots.find((d) => d.mesh === obj || d.label === obj);
    return fd ? FIELDS[fieldDots.indexOf(fd)] : null;
  }

  function onMove(ev) {
    pointerToNDC(ev);
    raycaster.setFromCamera(ndc, camera);
    // A dot or label picked directly takes priority (labels sit off the sphere).
    const overField = fieldUnderPointer();
    const hit = raycaster.intersectObject(sphereMesh, false)[0];
    if (hit) {
      const rd = vecToRaDec(hit.point);
      hoverMarker.position.copy(hit.point.clone().setLength(R * 1.01));
      hoverMarker.visible = true;
      lastHover = rd;
      if (callbacks.onHover) callbacks.onHover(rd, ev, overField || nearestField(hit.point));
    } else if (overField) {
      // Cursor is off the sphere but on a field's label/dot.
      hoverMarker.visible = false;
      lastHover = { ra: overField.ra, dec: overField.dec };
      if (callbacks.onHover) callbacks.onHover(lastHover, ev, overField);
    } else {
      hoverMarker.visible = false;
      lastHover = null;
      if (callbacks.onHover) callbacks.onHover(null, ev, null);
    }
  }

  // How far from the ecliptic (angular) a click still counts as a ring click.
  // Bigger = easier to hit / more sensitive.
  const RING_CLICK_TOL = 6 * DEG;

  function onClick(ev) {
    // TEMPORARILY DISABLED: clicking the ecliptic ring to change the date.
    // Remove this early return to re-enable.
    return;
    pointerToNDC(ev);
    raycaster.setFromCamera(ndc, camera);
    // A direct hit on the (thin) ecliptic tube always counts.
    if (eclipticRing) {
      const ringHit = raycaster.intersectObject(eclipticRing, false)[0];
      if (ringHit) {
        const { lon } = nearestEclipticSample(ringHit.point);
        if (callbacks.onRingClick) callbacks.onRingClick(lon);
        return;
      }
    }
    // Otherwise, a click that lands within RING_CLICK_TOL of the ecliptic still
    // counts — a wider, more forgiving hit zone around the ring.
    const hit = raycaster.intersectObject(sphereMesh, false)[0];
    if (hit && eclipticSamples.length) {
      const { lon, angle } = nearestEclipticSample(hit.point);
      if (angle <= RING_CLICK_TOL && callbacks.onRingClick) {
        callbacks.onRingClick(lon);
      }
    }
  }

  // Nearest ecliptic sample to a picked point: its longitude + angular distance.
  function nearestEclipticSample(point) {
    const p = point.clone().normalize();
    let best = 0, bestDot = -Infinity;
    for (const s of eclipticSamples) {
      const d = p.dot(s.vec.clone().normalize());
      if (d > bestDot) { bestDot = d; best = s.lon; }
    }
    const angle = Math.acos(Math.min(1, Math.max(-1, bestDot)));
    return { lon: best, angle };
  }

  renderer.domElement.addEventListener("pointermove", onMove);
  renderer.domElement.addEventListener("click", onClick);

  // ---- Resize + render loop ------------------------------------------------
  function resize() {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h); // updates both drawing buffer and CSS size
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  // Keep every text label at a constant on-screen height (regardless of depth
  // or zoom), and fade the ones on the far side of the sphere without resizing.
  const _camDir = new THREE.Vector3();
  const _lblDir = new THREE.Vector3();
  function updateLabels() {
    const tanHalfFov = Math.tan((camera.fov * DEG) / 2);
    _camDir.copy(camera.position).normalize();
    // Pin the Dec labels to the sphere's left edge (fixed relative to the view),
    // so they don't rotate away when the globe spins.
    const azL = Math.atan2(camera.position.y, camera.position.x) - Math.PI / 2;
    for (const dl of decLabels) {
      const d = dl.dec * DEG, r = R * 1.05;
      dl.spr.position.set(
        r * Math.cos(d) * Math.cos(azL),
        r * Math.cos(d) * Math.sin(azL),
        r * Math.sin(d)
      );
    }
    for (const spr of screenLabels) {
      const dist = camera.position.distanceTo(spr.position);
      const H = spr.userData.frac * 2 * tanHalfFov * dist; // world height for target screen size
      spr.scale.set(H * spr.userData.aspect, H, 1);
      if (spr.userData.pinned) {
        spr.material.opacity = 0.95; // always on the visible edge
      } else {
        // Front (facing camera) -> opaque; back (behind the globe) -> faded.
        const near = _lblDir.copy(spr.position).normalize().dot(_camDir);
        const t = Math.max(0, Math.min(1, (near + 0.25) / 0.5)); // 0 back .. 1 front
        spr.material.opacity = 0.14 + 0.84 * t;
      }
    }
  }

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    updateLabels();
    renderer.render(scene, camera);
  }
  animate();

  return {
    setSun, setTarget, setEcliptic, setCVZ,
    setFieldsVisible: (v) => { fieldGroup.visible = v; },
    getHover: () => lastHover,
  };
}

// Soft radial-gradient sprite texture for the Sun glow.
function radialSprite(color) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, color);
  g.addColorStop(0.4, color + "88");
  g.addColorStop(1, color + "00");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
