"use strict";

// ===========================================================================
// jwst-model.js — a simplified 3D model of the observatory itself.
//
// Pure geometry: no scene, no state, no astronomy. sphere.js drops the group
// at the centre of the celestial sphere and rotates it; everything here is
// built once, in the spacecraft's own axes.
//
// Local frame = JWST's V-frame (the same convention astro.js uses for Normal
// Roll, where the Sun sits in the V1-V3 plane on the sunshield side):
//
//   +X = V1 = boresight            +Z = V3 = telescope side ("up")
//   +Y = V2 = across the shield    -Z = sunshield normal -> points at the Sun
//
// Deliberately only the two things the diagram is about: the SUNSHIELD and the
// MIRROR. Everything else is the minimum needed to hold those two apart and
// stop them reading as floating sheets — a tower, a bus block, a backplane,
// and the secondary on its tripod. No solar array, antenna, momentum flap or
// instrument boxes: at this size they are noise.
//
// Modelled in METRES from the real spacecraft, then scaled once at the end, so
// the proportions need no tuning: 21.2 x 14.2 m sunshield, 6.5 m primary of 18
// segments 1.32 m flat-to-flat, secondary 7.4 m forward.
// ===========================================================================

import * as THREE from "three";

const SHIELD_LEN = 21.2;   // sunshield long axis (along V1) [m]
const SHIELD_WID = 14.2;   // sunshield short axis (along V2) [m]
// The one deliberate departure from scale: the primary is drawn oversized, and
// the secondary undersized, because the mirror is the point of the picture and
// at icon size a true-scale 6.5 m mirror disappears against a 21 m sunshield.
const MIRROR_EXAG = 1.4;
const SEG_FLAT = 1.32 * MIRROR_EXAG;   // mirror segment, flat-to-flat [m]
const SEG_R = SEG_FLAT / Math.sqrt(3); // ... as a circumradius [m]
const MIRROR_X = 1.6;      // primary mirror plane, along V1 [m]
const MIRROR_Z = 7.0;      // primary mirror centre, above the shield [m]
const SM_FWD = 8.0;        // secondary mirror, forward of the primary [m]
const SM_R = 0.32;         // secondary mirror radius [m]
// Radius of curvature of the primary. The real one is 15.88 m; drawn a little
// tighter so the dish reads as a dish at icon size, which also keeps the
// apparent curvature in step with the exaggerated aperture above.
const PRIMARY_ROC = 14.0;

const C_GOLD = 0xd8a83c;       // beryllium/gold mirror segments
const C_GOLD_RIM = 0x6f5619;   // backing plate, seen through the segment gaps
const C_BLACK = 0x24262c;      // aft optics, secondary housing
const C_STRUT = 0xc3c8d4;      // secondary-mirror tripod
const C_TOWER = 0x8b91a0;      // tower, backplane, bus
// Sunshield membranes, telescope side -> Sun side. The kapton reads pink-mauve
// from above and silvers off toward the sunward layer.
const C_SHIELD = [0xc9a3c0, 0xbb93b6, 0xb086ae, 0xc0b2c8, 0xdcd8e4];
const C_SHIELD_EDGE = 0x8a7f95;

function lambert(color, extra = {}) {
  return new THREE.MeshLambertMaterial({ color, ...extra });
}
// A flat, double-sided part (membranes, mirror facets).
function flat(color) {
  return lambert(color, { side: THREE.DoubleSide });
}
// Axis-aligned box, sized along V1 / V2 / V3 and placed in the local frame.
function box(sx, sy, sz, material, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
  m.position.set(x, y, z);
  return m;
}
// A cylinder spanning two points (CylinderGeometry is built along +Y).
const _UP = new THREE.Vector3(0, 1, 0);
function strut(a, b, radius, material) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, len, 6),
    material
  );
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(_UP, dir.normalize());
  return mesh;
}

// ---------------------------------------------------------------------------
// Sunshield: five membranes stacked toward the Sun (-Z) on a perimeter boom.
//
// The outline is a kite, longer forward (+X) than aft, with the corners cut
// back so it reads as the real five-layer membrane rather than a plain
// diamond. `k` scales it — each layer is slightly smaller than the one below,
// so the edges fan out and the stack stays legible nearly edge-on.
// ---------------------------------------------------------------------------
function shieldOutline(k) {
  const L = (SHIELD_LEN / 2) * k;
  const W = (SHIELD_WID / 2) * k;
  return [
    [1.00 * L, 0.00 * W],   // forward tip
    [0.54 * L, 0.86 * W],
    [-0.08 * L, 1.00 * W],  // widest point, just aft of centre
    [-0.70 * L, 0.64 * W],
    [-1.00 * L, 0.00 * W],  // aft tip
    [-0.70 * L, -0.64 * W],
    [-0.08 * L, -1.00 * W],
    [0.54 * L, -0.86 * W],
  ];
}

function sunshield() {
  const group = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const k = 0.86 + 0.035 * i;     // 0.86 (telescope side) .. 1.00 (Sun side)
    const z = -0.28 * i;
    const pts = shieldOutline(k);
    const shape = new THREE.Shape();
    shape.moveTo(pts[0][0], pts[0][1]);
    for (let j = 1; j < pts.length; j++) shape.lineTo(pts[j][0], pts[j][1]);
    shape.closePath();

    const layer = new THREE.Mesh(new THREE.ShapeGeometry(shape), flat(C_SHIELD[i]));
    layer.position.z = z;
    group.add(layer);
    group.add(new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(
        pts.map((p) => new THREE.Vector3(p[0], p[1], z))
      ),
      new THREE.LineBasicMaterial({ color: C_SHIELD_EDGE, transparent: true, opacity: 0.75 })
    ));
  }
  return group;
}

// One mirror segment: a solid, bevelled hexagonal prism with a unit
// circumradius, its polished face at local z = 0 and its normal at local +Z.
// Built once and shared by all 18 — only the placement differs.
function segmentGeometry() {
  const shape = new THREE.Shape();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 2; // pointy-top
    const x = Math.cos(a), y = Math.sin(a);
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: 0.16, steps: 1, bevelEnabled: true,
    bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 1,
  });
  g.translate(0, 0, -0.16);       // polished face to z = 0, body behind it
  return g;
}

// ---------------------------------------------------------------------------
// Primary mirror: 18 segments hex-packed as a 19-cell array with the centre
// cell left empty (the real mirror's central gap, where the aft-optics box
// sits). Axial coordinates (q, r) with hex distance <= 2; pointy-top hexes in
// the V2-V3 plane, so the pitch is sqrt(3)*R across V2 and 1.5*R along V3.
//
// Each segment is a separate solid sitting on the parent paraboloid rather
// than in one flat plane: pushed forward by the sag and tilted to the local
// surface normal, so every facet catches the light at its own angle and the
// array reads as a shallow dish. For x = (y^2+z^2)/2R,
//   sag = (y^2+z^2)/2R,   normal = normalise(1, -y/R, -z/R).
// ---------------------------------------------------------------------------
function primaryMirror() {
  const group = new THREE.Group();
  // Gold is a metal, so it needs a PBR material: the shine comes from
  // scene.environment (set up in sphere.js), not from a diffuse term.
  const gold = new THREE.MeshStandardMaterial({
    color: C_GOLD, metalness: 0.95, roughness: 0.25,
  });
  const geom = segmentGeometry();

  // Backing plate behind the array, so the widening gaps between the outer
  // segments read as depth rather than as holes onto the sky.
  const back = new THREE.Mesh(
    new THREE.CircleGeometry(SEG_R * 4.9, 6, Math.PI / 6),
    flat(C_GOLD_RIM)
  );
  back.rotateY(Math.PI / 2);      // face +X (the boresight)
  back.position.x = -0.35;
  group.add(back);

  const SQ3 = Math.sqrt(3);
  const n = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  for (let q = -2; q <= 2; q++) {
    for (let r = -2; r <= 2; r++) {
      const dist = (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
      if (dist > 2 || dist === 0) continue; // rings 1 and 2 only: 18 segments
      const y = SQ3 * SEG_R * (q + r / 2);
      const z = 1.5 * SEG_R * r;
      const seg = new THREE.Mesh(geom, gold);
      seg.position.set((y * y + z * z) / (2 * PRIMARY_ROC), y, z);
      n.set(1, -y / PRIMARY_ROC, -z / PRIMARY_ROC).normalize();
      // Clock every facet the same way (pointy-top along V3) instead of
      // letting the tilt twist it, so the array still tiles cleanly.
      v.set(0, 0, 1).addScaledVector(n, -n.z).normalize();
      u.crossVectors(v, n);
      seg.quaternion.setFromRotationMatrix(basis.makeBasis(u, v, n));
      // n.x is cos(tilt): grow each facet by 1/cos so the tilted segments still
      // project onto the same hex pitch and the gaps stay even across the dish.
      seg.scale.setScalar((SEG_R * 0.975) / n.x);
      group.add(seg);
    }
  }
  // Aft optics: the black box filling the mirror's central gap, so the hole
  // reads as part of the design rather than a missing segment.
  group.add(box(1.7, 1.45, 1.65, lambert(C_BLACK), 0.5, 0, 0));
  return group;
}

// ---------------------------------------------------------------------------
// createJWSTModel(span) -> THREE.Group
//
// `span` is the sunshield's long axis in world units; the model is scaled so
// everything else follows from it. The group's origin is the centre of the
// sunshield, which is also what it rotates about.
// ---------------------------------------------------------------------------
export function createJWSTModel(span = 0.45) {
  const root = new THREE.Group();
  const structure = lambert(C_TOWER);

  root.add(sunshield());

  // Spacecraft bus, on the Sun side of the shield.
  root.add(box(4.2, 4.0, 1.9, structure, -4.4, 0, -2.2));

  // Deployable tower: shield -> telescope. Slim, and stopping just short of
  // the mirror's centre, so the dish reads as carried rather than mounted on a
  // block.
  const TOWER_X = MIRROR_X - 0.9;
  const TOWER_TOP = MIRROR_Z - 1.0;
  root.add(box(1.2, 1.2, TOWER_TOP, structure, TOWER_X, 0, TOWER_TOP / 2));

  // ---- Optical telescope element -------------------------------------------
  const mirror = primaryMirror();
  mirror.position.set(MIRROR_X, 0, MIRROR_Z);
  root.add(mirror);

  // Backplane: the real one is an open graphite skeleton, so it is a short hub
  // plus two diagonals rather than a slab — a block behind the mirror reads as
  // bulk that is not there.
  const hub = new THREE.Vector3(TOWER_X, 0, TOWER_TOP);
  root.add(strut(hub, new THREE.Vector3(MIRROR_X - 0.4, 0, MIRROR_Z), 0.34, structure));
  for (const y of [2.6, -2.6]) {
    root.add(strut(hub, new THREE.Vector3(MIRROR_X - 0.4, y, MIRROR_Z + 2.9), 0.17, structure));
  }

  // Secondary mirror on its tripod, facing back down the boresight.
  const smPos = new THREE.Vector3(MIRROR_X + SM_FWD, 0, MIRROR_Z);
  root.add(box(0.55, 0.95, 0.95, lambert(C_BLACK), smPos.x + 0.3, 0, smPos.z));
  const sm = new THREE.Mesh(
    new THREE.CircleGeometry(SM_R, 20),
    new THREE.MeshStandardMaterial({ color: C_GOLD, metalness: 0.95, roughness: 0.2 })
  );
  sm.rotateY(-Math.PI / 2);          // face -X, back toward the primary
  sm.position.copy(smPos);
  root.add(sm);

  const strutMat = lambert(C_STRUT);
  const feet = [
    new THREE.Vector3(MIRROR_X, 3.9, MIRROR_Z + 2.1),
    new THREE.Vector3(MIRROR_X, -3.9, MIRROR_Z + 2.1),
    new THREE.Vector3(MIRROR_X, 0, MIRROR_Z - 4.4),
  ];
  for (const f of feet) root.add(strut(f, smPos, 0.10, strutMat));

  root.scale.setScalar(span / SHIELD_LEN);
  return root;
}
