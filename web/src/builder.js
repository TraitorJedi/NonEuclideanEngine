import { AmbientLight, BoxGeometry, Color, DirectionalLight, GridHelper, Group, Matrix4, Mesh,
  MeshLambertMaterial, MeshBasicMaterial, OrthographicCamera, Plane, Raycaster, Scene,
  Vector2, Vector3, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const key = 'nonEuclidean.builder.v1';
const models = { floor: 'build_floor', wall: 'build_wall', door: 'tunnel' };
const textures = { floor: 'checker_green', wall: 'checker_gray', door: 'gold' };

function matrix(piece) {
  const scale = piece.type === 'door' ? new Vector3(1.25, 1.2, 0.11) : new Vector3(1, 1, 1);
  return new Matrix4().makeRotationY(piece.turn * Math.PI / 2).scale(scale)
    .setPosition(piece.x, piece.type === 'floor' ? 0.008 : 0, piece.z);
}

export function buildDraft(pieces) {
  const objects = [{ model: 'ground', texture: 'checker_green', matrix: new Matrix4().makeScale(3, 1, 3) }];
  const portals = [];
  const pairs = new Map();
  for (const [pieceIndex, piece] of pieces.entries()) {
    objects.push({ pieceIndex, model: models[piece.type], texture: textures[piece.type], matrix: matrix(piece) });
    if (piece.type !== 'door') continue;
    const position = new Vector3(piece.x, 1.2, piece.z);
    const transform = new Matrix4().makeRotationY(piece.turn * Math.PI / 2)
      .scale(new Vector3(0.75, 1.2, 1)).setPosition(position);
    const portal = { pieceIndex, position, matrix: transform, inverse: transform.clone().invert(),
      normal: new Vector3(0, 0, -1).transformDirection(transform), sides: {} };
    const mate = pairs.get(piece.pair);
    if (!mate) { pairs.set(piece.pair, portal); continue; }
    for (const [entry, exit] of [[portal, mate], [mate, portal]]) {
      const warp = { exit, matrix: exit.matrix.clone().multiply(entry.inverse) };
      entry.sides = { front: warp, back: warp };
      portals.push(entry);
    }
    pairs.delete(piece.pair);
  }
  // A single endpoint is a solid door until its partner exists.
  for (const door of pairs.values()) {
    const piece = pieces[door.pieceIndex];
    objects.push({ pieceIndex: door.pieceIndex, model: 'build_wall', texture: textures.wall,
      matrix: new Matrix4().makeRotationY(piece.turn * Math.PI / 2)
        .scale(new Vector3(0.75, 1, 1)).setPosition(piece.x, 0, piece.z) });
  }
  return { objects, portals, spawn: [0, 1.5, 2] };
}

export function mountBuilder(assets, play, pause) {
  const dialog = document.querySelector('#builder');
  const canvas = dialog.querySelector('canvas');
  const status = dialog.querySelector('output');
  let pieces = [];
  try { pieces = JSON.parse(localStorage.getItem(key)) ?? []; } catch { /* New draft */ }
  let tool = 'floor', turn = 0, engine, controls;
  const history = [];
  const scene = new Scene();
  scene.background = new Color(0x212a25);
  const camera = new OrthographicCamera(-10, 10, 8, -8, 0.1, 500);
  camera.position.set(12, 15, 14);
  const placed = new Group();
  const grid = new GridHelper(200, 100, 0x6e8767, 0x445347);
  grid.position.set(1, 0.02, 1);
  scene.add(placed, grid, new AmbientLight(0xffffff, 1.7));
  const sun = new DirectionalLight(0xffffff, 2);
  sun.position.set(4, 10, 5);
  scene.add(sun);
  const resources = {};
  const ghost = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({
    color: 0xbbff81, opacity: 0.42, transparent: true, depthWrite: false,
  }));
  ghost.visible = false;
  scene.add(ghost);
  function redraw() {
    if (dialog.open && engine) engine.render(scene, camera);
  }
  function populate() {
    placed.clear();
    const layout = buildDraft(pieces);
    for (const object of layout.objects) {
      const { geometry, material } = resources[object.model];
      const mesh = new Mesh(geometry, material);
      mesh.userData.pieceIndex = object.pieceIndex;
      mesh.applyMatrix4(object.matrix);
      placed.add(mesh);
    }
    redraw();
  }
  let loading;
  async function init() {
    engine = new WebGLRenderer({ canvas, antialias: true });
    engine.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    controls = new OrbitControls(camera, canvas);
    controls.enabled = tool === "orbit";
    controls.maxPolarAngle = Math.PI * 0.47;
    controls.minZoom = 0.25; controls.maxZoom = 6;
    controls.addEventListener('change', redraw);
    await Promise.all(Object.entries({ ground: 'checker_green', ...Object.fromEntries(
      Object.keys(models).map(type => [models[type], textures[type]])) }).map(async ([model, texture]) => {
      const [asset, map] = await Promise.all([assets.mesh(model), assets.texture(texture)]);
      resources[model] = { geometry: asset.geometry, material: new MeshLambertMaterial({ map }) };
    }));
    populate();
  }
  new ResizeObserver(() => {
    if (!dialog.open || !engine || !canvas.clientHeight) return;
    const ratio = canvas.clientWidth / canvas.clientHeight;
    camera.left = -8 * ratio; camera.right = 8 * ratio;
    camera.updateProjectionMatrix();
    engine.setSize(canvas.clientWidth, canvas.clientHeight, false);
    redraw();
  }).observe(canvas);
  document.querySelector('#edit').onclick = async () => {
    pause(); dialog.showModal();
    try { loading ??= init(); await loading; redraw(); }
    catch { status.textContent = 'Could not load the building view. Reload to retry.'; }
  };
  function save() {
    try { localStorage.setItem(key, JSON.stringify(pieces)); }
    catch { status.textContent = 'Device storage unavailable'; }
    dialog.querySelector('[data-action=undo]').disabled = !history.length;
    populate();
  }
  function point(event) {
    const rect = canvas.getBoundingClientRect();
    const pointer = new Vector2(2 * (event.clientX - rect.left) / rect.width - 1,
      1 - 2 * (event.clientY - rect.top) / rect.height);
    const ray = new Raycaster();
    ray.setFromCamera(pointer, camera);
    const hit = ray.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), 0), new Vector3());
    if (!hit) return;
    const edge = tool === 'wall' || tool === 'door';
    const dx = edge && turn % 2 ? 1 : 0, dz = edge && !(turn % 2) ? 1 : 0;
    return { x: Math.round((hit.x - dx) / 2) * 2 + dx,
      z: Math.round((hit.z - dz) / 2) * 2 + dz, type: tool, turn };
  }
  function preview(event) {
    const piece = point(event);
    ghost.visible = !!piece && !['orbit', 'erase'].includes(tool);
    if (ghost.visible) {
      const floor = tool === 'floor';
      ghost.position.set(piece.x, floor ? 0.045 : 1.2, piece.z);
      ghost.rotation.y = turn * Math.PI / 2;
      ghost.scale.set(2, floor ? 0.04 : 2.4, floor ? 2 : 0.2);
    }
    redraw();
  }
  canvas.addEventListener('pointermove', preview);
  canvas.addEventListener('pointerleave', () => { ghost.visible = false; redraw(); });
  canvas.addEventListener('pointerdown', event => {
    if (!resources.ground || !resources.build_wall || !resources.tunnel || !resources.build_floor || tool === 'orbit' || event.button !== 0) return;
    const piece = point(event);
    if (!piece) return;
    let index;
    if (tool === 'erase') {
      const rect = canvas.getBoundingClientRect();
      const ray = new Raycaster();
      ray.setFromCamera(new Vector2(2*(event.clientX-rect.left)/rect.width-1,
        1-2*(event.clientY-rect.top)/rect.height), camera);
      const hit = ray.intersectObjects(placed.children.slice(1))[0];
      if (!hit) return;
      index = hit.object.userData.pieceIndex;
    } else {
      index = pieces.findIndex(p => p.x === piece.x && p.z === piece.z);
      if (index >= 0 && pieces[index].type === tool && pieces[index].turn === turn) return;
    }
    history.push(pieces.slice());
    if (index >= 0) pieces.splice(index, 1);
    if (tool !== 'erase') {
      if (tool === 'door') {
        const counts = new Map();
        for (const p of pieces.filter(p => p.type === 'door')) counts.set(p.pair, (counts.get(p.pair) ?? 0) + 1);
        piece.pair = [...counts].find(([, n]) => n === 1)?.[0] ?? Math.max(0, ...counts.keys()) + 1;
        status.textContent = counts.has(piece.pair) ? 'Door pair ' + piece.pair + ' linked' : 'Place the other end of door pair ' + piece.pair;
      }
      pieces.push(piece);
    }
    save();
  });
  dialog.onclick = event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.tool) {
      tool = button.dataset.tool;
      if (controls) controls.enabled = tool === 'orbit';
      for (const b of dialog.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b === button));
      ghost.visible = false; redraw();
      status.textContent = tool === 'orbit' ? 'Drag to orbit. Pinch or scroll to zoom. Right-drag or use two fingers to pan.' : 'Tap the grid to ' + (tool === 'erase' ? 'erase a piece' : 'place a ' + tool);
    }
    switch (button.dataset.action) {
      case 'rotate': turn = (turn + 1) % 4; status.textContent = 'Placement rotation ' + turn * 90 + '°'; ghost.visible = false; redraw(); break;
      case 'undo': if (history.length) { pieces = history.pop(); save(); } break;
      case 'close': dialog.close(); break;
      case 'play': if (resources.ground) { dialog.close(); play(buildDraft(pieces)); } break;
    }
  };
}
