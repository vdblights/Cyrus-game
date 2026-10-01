import { FACADE_BAYS, FACADE_FLOORS, WINDOW } from './textures.js';

/**
 * Windows with depth, cut into the facade in its own fragment shader.
 *
 * A facade used to be a photograph of a wall: every window painted flush with
 * the brick, glass a grey card, a broken pane a black square with white
 * triangles on it. At any distance that is the thing that gives the city away,
 * because a building is most of every frame and a real window is a hole in a
 * wall a quarter of a metre thick, with a room behind it.
 *
 * The windows are already exactly where a shader can find them. The facade
 * tile is four bays by three storeys, `wallUV` snaps every wall to whole bays
 * and storeys, and the painter lays each opening out by `WINDOW`. So each
 * fragment of a wall knows which window cell it is in and where in it, and a
 * window is a ray-box problem rather than geometry:
 *
 *  - the opening is a tunnel `DEPTH` deep. A view ray entering it either
 *    reaches the back plane or strikes a reveal first; a reveal wears the wall
 *    beside it and its own normal, so the sun picks out one side and the
 *    lintel soffit stays in shade;
 *  - glass and boarding sit on the back plane, sampled from the painted map
 *    at the point the ray reaches, so the frame and the boards move with the
 *    parallax a real recess has. Glass is smooth, so it mirrors the sky;
 *  - a broken pane opens onto a room the depth of a few metres and the size
 *    of the bay and storey — floor, ceiling, side walls, back wall — dim, and
 *    darker the further in. Shards still in the frame are kept;
 *  - every surface inside the tunnel and the room traces one ray toward the
 *    sun through the opening, so a reveal casts its shadow on the glass and a
 *    low sun lays a patch of light across a floor.
 *
 * None of it is geometry. Nothing is in `world.boxes` or `world.solids`, the
 * shadow map and the occlusion pass still see a flat wall, and a bullet still
 * stops at the wall plane — a quarter of a metre short of the glass, which is
 * the same thing a painted window did. It costs nothing on the seeded stream,
 * because it is a material property, and nothing on the draw-call budget.
 */

/** How far the glass sits back from the wall face, in metres. */
export const WINDOW_DEPTH = 0.22;

const f = (v) => v.toFixed(5);
const RECT_U0 = (1 - WINDOW.w) / 2, RECT_U1 = 1 - RECT_U0;
// The painter measures from the top of a storey; the UVs run up from its foot.
const RECT_V0 = 1 - WINDOW.top - WINDOW.h, RECT_V1 = 1 - WINDOW.top;

const PARS = /* glsl */`
uniform float uWindows[${FACADE_BAYS * FACADE_FLOORS}];
uniform float uWindowsOn;

const vec2 W_CELLS = vec2(${f(FACADE_BAYS)}, ${f(FACADE_FLOORS)});
const vec2 W_R0 = vec2(${f(RECT_U0)}, ${f(RECT_V0)});
const vec2 W_R1 = vec2(${f(RECT_U1)}, ${f(RECT_V1)});
const float W_DEPTH = ${f(WINDOW_DEPTH)};

float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

/** 1 inside the rectangle, 0 outside, with a few centimetres of penumbra. */
float wInside(vec2 a, vec2 r0, vec2 r1) {
  vec2 m = min(a - r0, r1 - a);
  return smoothstep(-0.02, 0.02, min(m.x, m.y));
}

/**
 * Light from the sun reaching local point h (z <= 0, into the wall) through
 * the opening: the ray toward the sun must clear the rectangle at the wall
 * face, and at the glass line if it starts behind it.
 */
float wSunThrough(vec3 h, vec3 L, vec2 r0, vec2 r1) {
  if (L.z <= 0.001) return 0.0;
  float vis = wInside(h.xy + L.xy * (-h.z / L.z), r0, r1);
  if (h.z < -W_DEPTH - 0.001) vis *= wInside(h.xy + L.xy * ((-W_DEPTH - h.z) / L.z), r0, r1);
  return vis;
}
`;

const SOLVE = /* glsl */`
  // ---- windows: which surface of the opening this fragment really shows
  int wKind = 0;                  // 0 wall, 1 glass/boards, 2 reveal, 3 room
  vec2 wUv = vMapUv;
  vec3 wNormal = vec3(0.0);
  vec3 wAlbedo = vec3(1.0);
  float wSun = 1.0, wAo = 1.0, wRough = 0.9, wSpec = 1.0;
  vec2 wDux = dFdx(vMapUv), wDuy = dFdy(vMapUv);
  if (uWindowsOn > 0.5) {
    vec3 wP = -vViewPosition;
    vec3 dpx = dFdx(wP), dpy = dFdy(wP);
    float det = wDux.x * wDuy.y - wDux.y * wDuy.x;
    vec3 wN = normalize(vNormal);
    vec3 up = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    if (abs(det) > 1e-12 && abs(dot(wN, up)) < 0.3) {
      // metres of wall per unit of UV, along the wall and up it
      vec3 T = (dpx * wDuy.y - dpy * wDux.y) / det;
      vec3 B = (dpy * wDux.x - dpx * wDuy.x) / det;
      float lenT = length(T), lenB = length(B);
      vec2 g = vMapUv * W_CELLS;
      vec2 cell = floor(g), fr = g - cell;
      if (lenT > 0.0 && lenB > 0.0 && all(greaterThan(fr, W_R0)) && all(lessThan(fr, W_R1))) {
        vec3 Tn = T / lenT, Bn = B / lenB;
        vec2 cs = vec2(lenT, lenB) / W_CELLS;      // the cell in metres
        vec2 r0 = W_R0 * cs, r1 = W_R1 * cs;       // the opening in metres
        vec3 p = vec3(fr * cs, 0.0);
        vec3 d = -normalize(vViewPosition);
        vec3 dl = vec3(dot(d, Tn), dot(d, Bn), min(dot(d, wN), -0.03));
        vec3 Lv = vec3(0.0, 0.0, -1.0);
        #if NUM_DIR_LIGHTS > 0
          Lv = directionalLights[0].direction;     // the sun, sorted first
        #endif
        vec3 Ll = vec3(dot(Lv, Tn), dot(Lv, Bn), dot(Lv, wN));
        vec2 toUv = 1.0 / vec2(lenT, lenB);
        vec2 cellUv = cell / W_CELLS;

        int iu = int(mod(cell.x, W_CELLS.x));
        int iv = int(mod(cell.y, W_CELLS.y));
        float state = uWindows[(int(W_CELLS.y) - 1 - iv) * int(W_CELLS.x) + iu];

        // where the ray leaves the tunnel sideways, and where it meets the glass
        float tx = dl.x > 0.0 ? (r1.x - p.x) / dl.x : (dl.x < 0.0 ? (r0.x - p.x) / dl.x : 1e9);
        float ty = dl.y > 0.0 ? (r1.y - p.y) / dl.y : (dl.y < 0.0 ? (r0.y - p.y) / dl.y : 1e9);
        float tSide = min(tx, ty);
        float tBack = W_DEPTH / -dl.z;

        if (tSide < tBack) {
          // a reveal: the wall's own material, turned to face into the opening
          vec3 h = p + dl * tSide;
          float depth = -h.z;
          vec2 at = h.xy;
          if (tx < ty) {
            wNormal = dl.x > 0.0 ? -Tn : Tn;
            at.x = dl.x > 0.0 ? r1.x + 0.05 + depth : r0.x - 0.05 - depth;
          } else {
            wNormal = dl.y > 0.0 ? -Bn : Bn;
            at.y = dl.y > 0.0 ? r1.y + 0.05 + depth : r0.y - 0.05 - depth;
          }
          wKind = 2;
          wUv = cellUv + at * toUv;
          wSun = wSunThrough(h, Ll, r0, r1);
          wAo = 0.82 - 0.3 * depth / W_DEPTH;
          wRough = 0.95;
        } else {
          vec3 q = p + dl * tBack;
          wUv = cellUv + q.xy * toUv;
          // whether a shard is still in the frame, read off a blurred lookup:
          // the painted pane is grainy, and a sharp threshold on grain is a
          // jagged edge
          vec3 tex = textureGrad(map, wUv, wDux * 6.0, wDuy * 6.0).rgb;
          float shard = smoothstep(0.035, 0.07, dot(tex, vec3(0.3, 0.5, 0.2)));
          if (state > 0.5 && state < 1.5 && shard < 0.5) {
            // broken: on into the room behind it
            float roomD = 2.6 + 2.4 * wHash(cell + vColor.rg * 17.0);
            float rx = dl.x > 0.0 ? (cs.x - q.x) / dl.x : (dl.x < 0.0 ? -q.x / dl.x : 1e9);
            float ry = dl.y > 0.0 ? (cs.y - q.y) / dl.y : (dl.y < 0.0 ? -q.y / dl.y : 1e9);
            float rz = roomD / -dl.z;
            float tr = min(rx, min(ry, rz));
            vec3 h = q + dl * tr;
            float shade = wHash(cell * 1.7 + vColor.gb * 9.0);
            if (tr == rz) {               // back wall
              wNormal = wN;
              wAlbedo = mix(vec3(0.30, 0.27, 0.24), vec3(0.21, 0.21, 0.22), shade);
            } else if (tr == ry) {        // floor or ceiling
              wNormal = dl.y > 0.0 ? -Bn : Bn;
              wAlbedo = dl.y > 0.0 ? vec3(0.26, 0.25, 0.24) : vec3(0.15, 0.125, 0.10);
            } else {                      // side walls
              wNormal = dl.x > 0.0 ? -Tn : Tn;
              wAlbedo = mix(vec3(0.27, 0.24, 0.21), vec3(0.19, 0.19, 0.20), shade) * 0.9;
            }
            float into = -h.z - W_DEPTH;
            wKind = 3;
            wSun = wSunThrough(h, Ll, r0, r1);
            wAo = 0.8 * exp(-into * 0.26);
            wSpec = 0.2;
            wRough = 0.95;
          } else {
            // glass or boards, or a shard still in the frame
            wKind = 1;
            wNormal = wN;
            wSun = wSunThrough(q, Ll, r0, r1);
            bool glass = state < 0.5 || (state < 1.5 && shard >= 0.5);
            wAo = glass ? 0.8 : 0.7;
            wRough = glass ? 0.08 : 0.85;
            wAlbedo = glass ? vec3(0.32) : vec3(1.0);
          }
        }
      }
    }
  }
`;

const MAP = /* glsl */`
#ifdef USE_MAP
  vec4 sampledDiffuseColor = wKind == 0 ? texture2D(map, vMapUv)
    : wKind == 3 ? vec4(wAlbedo, 1.0)
    : textureGrad(map, wUv, wDux, wDuy) * vec4(wAlbedo, 1.0);
  diffuseColor *= sampledDiffuseColor;
#endif
`;

/**
 * Give a facade material its windows. `states` is what the painter put in
 * each of the twelve (`facadeWindows`). Every facade compiles to the same
 * program, so the states ride in a per-material uniform.
 */
export function cutWindows(material, states) {
  material.userData.windows = { value: Float32Array.from(states) };
  material.userData.windowsOn = { value: 1 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindows = material.userData.windows;
    shader.uniforms.uWindowsOn = material.userData.windowsOn;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PARS)
      .replace('#include <map_fragment>', SOLVE + MAP)
      .replace('#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  if (wKind != 0) roughnessFactor = wRough;')
      .replace('#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\n  if (wKind != 0) normal = wNormal;')
      .replace('#include <aomap_fragment>', /* glsl */`
  reflectedLight.directDiffuse *= wSun;
  reflectedLight.directSpecular *= wSun;
  reflectedLight.indirectDiffuse *= wAo;
  reflectedLight.indirectSpecular *= mix(1.0, wAo, 0.6) * wSpec;
  #include <aomap_fragment>`);
  };
  material.customProgramCacheKey = () => 'windows';
  return material;
}
