import * as THREE from 'three';
import { SUN_DIR } from './atmosphere.js';

/**
 * Two shadow cascades for the one sun.
 *
 * A single shadow map has to choose between reach and sharpness. Spread over
 * the hundred metres the city needs, 2048 texels is five centimetres apiece
 * across the light — and with the sun 24 degrees up, the map lies on the
 * ground stretched by 1/sin(24°), so along the sun's bearing it is thirteen.
 * That is the smear under every barrier and the stair-stepped edge on every
 * shadow near the player, which are exactly the shadows a player looks at.
 *
 * So there are two maps. The sun keeps the wide one. A second directional
 * light at the same angle, with zero intensity — it lights nothing — renders
 * a tight map around the patch of street in front of the player, at about a
 * centimetre a texel. The sun's shadow lookup is rewritten to read the tight
 * map wherever it covers and the wide one everywhere else, blended across the
 * last stretch of the tight map so the seam never shows.
 *
 * Both are snapped to whole texels in the light's own frame. A shadow box
 * that slides continuously with the player re-rasterises every edge at a
 * sub-texel offset each frame, which reads as shadows crawling along walls
 * as you walk; snapped, an edge only ever moves when the thing casting it does.
 */

/** How far the shadow-casting lights sit from the ground they light. */
export const SUN_DISTANCE = 77;

// The light's frame. three aims a shadow camera with lookAt and +Y up, so its
// axes are these, and snapping in them is snapping in shadow-map texels.
const Z = SUN_DIR.clone();
const X = new THREE.Vector3(0, 1, 0).cross(Z).normalize();
const Y = Z.clone().cross(X);
const P = new THREE.Vector3();

/**
 * Centre a directional light's shadow box on `center`, snapped to the texel
 * grid of a map `span` metres either side and `size` texels across.
 */
export function placeShadow(light, center, span, size) {
  const texel = (span * 2) / size;
  const a = Math.round(center.dot(X) / texel) * texel;
  const b = Math.round(center.dot(Y) / texel) * texel;
  const c = center.dot(Z);
  P.copy(X).multiplyScalar(a).addScaledVector(Y, b).addScaledVector(Z, c);
  light.target.position.copy(P);
  light.position.copy(P).addScaledVector(SUN_DIR, SUN_DISTANCE);
  light.target.updateMatrixWorld();
  light.updateMatrixWorld();
}

/** Set a light's shadow box to `span` metres either side and `size` texels. */
export function sizeShadow(light, span, size) {
  const s = light.shadow;
  if (s.mapSize.x !== size) {
    s.mapSize.set(size, size);
    s.map?.dispose();
    s.map = null;                 // three rebuilds it at the new size
  }
  const c = s.camera;
  c.left = -span; c.right = span; c.top = span; c.bottom = -span;
  c.updateProjectionMatrix();
}

let installed = null;

/**
 * Rewrite the directional-light loop so light 0 — the sun — reads the tight
 * map (shadow 1) where it covers and the wide one (shadow 0) elsewhere.
 *
 * Shadow-casting lights are sorted first and keep scene order among
 * themselves, so this only holds while the sun is the first shadow-casting
 * directional light in the scene and the cascade the second. With one
 * shadowed light — the cascade switched off, or a tier without it — the
 * original lookup is what compiles.
 *
 * @returns {boolean} whether the cascade is in the shader; false only if a
 *          three upgrade has moved the line it replaces
 */
export function installShadowCascade() {
  if (installed !== null) return installed;
  installed = false;
  const C = THREE.ShaderChunk;
  const original = /* glsl */`		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;`;
  if (!C.lights_fragment_begin.includes(original)) {
    // a three upgrade moved the line; better no cascade than a broken shader
    console.warn('shadow cascade: three\'s light loop has changed, cascade not installed');
    return false;
  }
  const cascaded = /* glsl */`
		#if ( NUM_DIR_LIGHT_SHADOWS > 1 ) && ( UNROLLED_LOOP_INDEX == 0 )
		{
			// the sun: tight map where it covers, wide map beyond, blended over
			// the outer tenth of the tight one so its edge never shows
			vec4 nc = vDirectionalShadowCoord[ 1 ];
			vec3 np = nc.xyz / nc.w;
			vec2 inset = min( np.xy, 1.0 - np.xy );
			float nearW = ( np.z <= 1.0 ) ? smoothstep( 0.0, 0.1, min( inset.x, inset.y ) ) : 0.0;
			float s = 1.0;
			if ( directLight.visible && receiveShadow ) {
				DirectionalLightShadow ns = directionalLightShadows[ 1 ];
				float nearS = nearW > 0.0
					? getShadow( directionalShadowMap[ 1 ], ns.shadowMapSize, ns.shadowIntensity, ns.shadowBias, ns.shadowRadius, nc )
					: 1.0;
				float farS = nearW < 1.0
					? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] )
					: 1.0;
				s = mix( farS, nearS, nearW );
			}
			directLight.color *= s;
		}
		#elif ( NUM_DIR_LIGHT_SHADOWS > 1 ) && ( UNROLLED_LOOP_INDEX == 1 )
			// the cascade light itself: zero intensity, nothing to shadow
		#else
${original}
		#endif`;
  C.lights_fragment_begin = C.lights_fragment_begin.replace(original, cascaded);
  installed = true;
  return true;
}
