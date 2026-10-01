import * as THREE from 'three';

/**
 * The sky, the sun and the air between them — one model, so they agree.
 *
 * The sky used to be a painted sunset: an orange horizon all the way round
 * the compass and a navy zenith, lit by a sun standing 31 degrees up. That is
 * a mid-afternoon sun over an evening sky, and although nobody would name
 * the mismatch, it is most of why the city read as a set: the light on the
 * walls and the sky above them disagreed about what time it was. Distance did
 * not help — the fog was one flat brown at every height and in every
 * direction, so a building 150 m away was the same colour as the air a metre
 * off the ground, and the city had no depth except by size.
 *
 * Everything here reads one function, `ashAtmosphere(direction)`:
 *
 * - the **sky dome** draws it, plus a small sun disc bright enough to bloom;
 * - the **environment map** is rendered from the same dome, so every PBR
 *   surface is lit by the sky actually drawn above it;
 * - the **fog** is replaced for every built-in material: it thickens toward
 *   the ground and thins with height (a ruined city's dust sits low), and its
 *   colour is the sky's own horizon in the direction you are looking, warm
 *   toward the sun and cool away from it. A far building therefore fades into
 *   exactly the sky behind it, which is what aerial perspective is.
 *
 * The sun sits 24 degrees up — the long end of the afternoon. Low enough for
 * the warm light and the glowing horizon to be physically the same hour, and
 * chosen by measurement rather than taste: sampling every walkable point of
 * the street on seeds 1, 7 and 99991 for a clear line to the sun, 18 degrees
 * left 17-20% of the street and as little as a fifth of the plaza in direct
 * light, which made the arena a cave. 24 keeps 30% of the street and 38-71%
 * of the plaza sunlit, against 40% and 54-82% at the old 31.
 *
 * Nothing in this module constructs a three object at import. Vectors carry
 * no UUID; materials and meshes are only made inside the functions, which the
 * game calls from inside `reserve`.
 */

const ELEVATION = THREE.MathUtils.degToRad(24);
const AZIMUTH = new THREE.Vector2(-60, -30).normalize();   // unchanged: the sun still sets over the same streets

/** Unit vector toward the sun. */
export const SUN_DIR = new THREE.Vector3(
  AZIMUTH.x * Math.cos(ELEVATION), Math.sin(ELEVATION), AZIMUTH.y * Math.cos(ELEVATION)).normalize();

/** Linear-light sun colour at this elevation: gold, not the orange of a sunset. */
export const SUN_COLOR = new THREE.Color(1.0, 0.78, 0.55);

/** Height over which the dust layer thins by a factor of e. */
const HAZE_FALLOFF = 14;

const v3 = (v) => `vec3(${v.x.toFixed(6)}, ${v.y.toFixed(6)}, ${v.z.toFixed(6)})`;
const rgb = (c) => `vec3(${c.r.toFixed(6)}, ${c.g.toFixed(6)}, ${c.b.toFixed(6)})`;

/**
 * Sky radiance along a direction, in linear light, without the sun's disc.
 *
 * Not a full scattering integral: a zenith-to-horizon blend weighted by how
 * much air the eye looks through, a horizon that is warm on the sun's side
 * and cool on the other, and a Henyey–Greenstein lobe for the forward
 * scattering that puts a bright haze around the sun. Those three are the
 * parts of a real sky that the eye checks; the rest is refinement this scene
 * cannot show.
 */
const ATMOSPHERE_GLSL = /* glsl */`
  const vec3 ASH_SUN = ${v3(SUN_DIR)};

  vec3 ashAtmosphere(vec3 d, float glow) {
    float up = clamp(d.y, 0.0, 1.0);
    float mu = dot(d, ASH_SUN);

    // the horizon is looked at through many times the air the zenith is
    float air = pow(1.0 - up, 4.0);

    vec3 zenith = vec3(0.050, 0.095, 0.215);
    vec3 horizonAway = vec3(0.235, 0.215, 0.205);
    vec3 horizonSun = vec3(0.980, 0.560, 0.270);

    // how far round toward the sun this bearing is, 0 opposite to 1 under it
    vec2 bearing = normalize(d.xz + vec2(1e-5));
    float toward = pow(dot(bearing, normalize(ASH_SUN.xz)) * 0.5 + 0.5, 2.5);
    vec3 horizon = mix(horizonAway, horizonSun, toward);

    vec3 col = mix(zenith, horizon, air);

    // below the horizon the air is lit dust over a ruined city, not more sky
    if (d.y < 0.0) col = mix(horizon, vec3(0.13, 0.11, 0.095), clamp(-d.y * 3.0, 0.0, 1.0));

    // Forward scattering off dust and droplets: a broad glow round the sun.
    // Added after the horizon split, not before it, or the glow stops dead
    // at the horizon and draws a line across the sky.
    const float g = 0.72;
    float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5);
    col += vec3(1.0, 0.66, 0.38) * hg * 0.022 * glow * (0.3 + 0.7 * air);
    return col;
  }
`;

// ---------------------------------------------------------------------- fog

/**
 * Height fog for every built-in material, installed by rewriting three's fog
 * shader chunks before anything compiles.
 *
 * The density integral along the ray is analytic for an exponential layer,
 * so this is a handful of instructions per pixel, not a march. The scene's
 * `FogExp2` still exists and still supplies `fogDensity` — the ground-level
 * density — which keeps the quality tiers and anything else that reads the
 * fog working unchanged.
 */
let installed = false;

export function installAtmosphere() {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk;

  C.fog_pars_vertex = /* glsl */`
    #ifdef USE_FOG
      varying vec3 vFogWorld;
    #endif
  `;
  // world position without a matrix inverse: the view matrix's rotation
  // transposed is a row-vector multiply
  C.fog_vertex = /* glsl */`
    #ifdef USE_FOG
      vFogWorld = cameraPosition + (vec4(mvPosition.xyz, 0.0) * viewMatrix).xyz;
    #endif
  `;
  C.fog_pars_fragment = /* glsl */`
    #ifdef USE_FOG
      uniform vec3 fogColor;
      uniform float fogDensity;
      varying vec3 vFogWorld;
      ${ATMOSPHERE_GLSL}

      // optical depth through a layer whose density falls as exp(-h / H)
      float ashFogDepth(float y0, float y1, float dist) {
        const float b = ${(1 / HAZE_FALLOFF).toFixed(6)};
        float dy = y1 - y0;
        float k = abs(dy) > 1e-3 ? (1.0 - exp(-b * dy)) / (b * dy) : 1.0;
        return fogDensity * exp(-b * max(y0, 0.0)) * k * dist;
      }
    #endif
  `;
  C.fog_fragment = /* glsl */`
    #ifdef USE_FOG
      vec3 fogRay = vFogWorld - cameraPosition;
      float fogDist = length(fogRay);
      vec3 fogDir = fogRay / max(fogDist, 1e-4);
      float fogFactor = 1.0 - exp(-ashFogDepth(cameraPosition.y, vFogWorld.y, fogDist));
      // the air is lit like the horizon behind it: rays aimed down still
      // look out through dust at eye level, not into the ground
      vec3 fogDir2 = normalize(vec3(fogDir.x, max(fogDir.y, 0.0) * 0.5 + 0.02, fogDir.z));
      gl_FragColor.rgb = mix(gl_FragColor.rgb, ashAtmosphere(fogDir2, 0.35), fogFactor);
    #endif
  `;
}

// ---------------------------------------------------------------------- sky

const SKY_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = position;     // the dome is centred on the camera, so this is the view ray
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */`
  uniform float disc;
  varying vec3 vDir;
  ${ATMOSPHERE_GLSL}

  void main() {
    vec3 d = normalize(vDir);
    vec3 col = ashAtmosphere(d, 1.0);

    // The sun as the sun is: small, and far brighter than anything around it,
    // so the bloom makes its glare rather than a painted halo. Half a degree
    // across is a few pixels at this field of view; a little more so it
    // survives being looked at from under the brim of a building.
    float mu = dot(d, ASH_SUN);
    float edge = smoothstep(0.99994, 0.99997, mu);
    col += ${rgb(SUN_COLOR)} * edge * 38.0 * disc;

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** The dome's material. `disc` is 0 when the dome is rendered into the environment. */
export function skyMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { disc: { value: 1 } },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
}

/**
 * The environment map, rendered from the same dome the player sees.
 *
 * The disc is left out: its reflection in every surface would be a pinprick
 * of 38x white that the directional light's own specular already covers, and
 * a very bright texel in a cubemap is where PMREM's fireflies come from.
 */
export function environmentFrom(renderer, material) {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), material));
  const pmrem = new THREE.PMREMGenerator(renderer);
  material.uniforms.disc.value = 0;
  const env = pmrem.fromScene(scene, 0, 0.1, 50).texture;
  material.uniforms.disc.value = 1;
  pmrem.dispose();
  return env;
}
