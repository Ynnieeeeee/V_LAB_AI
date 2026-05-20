import * as THREE from "three";

const loader = new THREE.TextureLoader();

const fireTexture = loader.load(
    './assets/img/fire.png'
);

const smokeTexture = loader.load(
    './assets/img/smoke.png'
);

function markEffectObject(obj) {
    if (!obj) return obj;
    obj.name = obj.name || 'reaction_effect';
    obj.userData.isReactionEffect = true;
    obj.userData.notDraggable = true;
    obj.userData.ignoreRaycast = true;
    obj.raycast = () => null;
    obj.traverse?.(child => {
        child.userData.isReactionEffect = true;
        child.userData.notDraggable = true;
        child.userData.ignoreRaycast = true;
        child.raycast = () => null;
    });
    return obj;
}

export function applyReactionEffects(
    scene,
    reaction,
    position
) {

    if (!reaction) return;

    const effects = reaction.effects || reaction;

    console.log(
        "APPLY REACTION EFFECTS:",
        effects
    );

    // =====================================================
    // FIRE
    // =====================================================

    if (effects.fire > 0.4) {

        spawnFireParticles(
            scene,
            position,
            effects.fire
        );
    }

    // =====================================================
    // SMOKE
    // =====================================================

    if (effects.smoke > 0.3) {

        spawnSmoke(
            scene,
            position,
            effects.smoke
        );
    }

    // =====================================================
    // GAS
    // =====================================================

    if (effects.gas > 0.3) {

        spawnGasCloud(
            scene,
            position,
            effects.gas
        );
    }

    // =====================================================
    // PRECIPITATE
    // =====================================================

    if (effects.precipitate) {
        spawnPrecipitate(
            scene,
            position,
            effects.precipitateColor || "#aee1ff"
        );
    }

    // =====================================================
    // EXPLOSION
    // =====================================================

    if (effects.explosion > 0.5) {

        createShockwave(
            scene,
            position,
            effects.explosion
        );
    }

    // =====================================================
    // HEAT DISTORTION
    // =====================================================

    if (effects.heat > 0.4) {

        heatDistortion(
            scene,
            position,
            effects.heat
        );
    }
}

// =========================================================
// FIRE PARTICLES
// =========================================================

export function spawnFireParticles(
    scene,
    position,
    intensity = 1
) {
    if (typeof intensity === 'object' && intensity !== null) {
        intensity = intensity.intensity ?? 1;
    }

    const particleCount =
        Math.floor(60 * intensity);

    const geometry =
        new THREE.BufferGeometry();

    const positions = [];
    const sizes = [];

    for (let i = 0; i < particleCount; i++) {

        positions.push(

            position.x +
            (Math.random() - 0.5) * 0.25,

            position.y +
            Math.random() * 0.5,

            position.z +
            (Math.random() - 0.5) * 0.25
        );

        sizes.push(
            Math.random() * 0.15 + 0.05
        );
    }

    geometry.setAttribute(

        "position",

        new THREE.Float32BufferAttribute(
            positions,
            3
        )
    );

    geometry.setAttribute(

        "size",

        new THREE.Float32BufferAttribute(
            sizes,
            1
        )
    );

    const material =
        new THREE.PointsMaterial({

            map: fireTexture,

            transparent: true,

            depthWrite: false,

            blending:
                THREE.AdditiveBlending,

            size: 0.2
        });

    const particles =
        new THREE.Points(
            geometry,
            material
        );

    markEffectObject(particles);
    scene.add(particles);

    // =====================================================
    // ANIMATION
    // =====================================================

    const start = performance.now();

    function animate() {

        const elapsed =
            (performance.now() - start)
            / 1000;

        particles.position.y += 0.01;

        material.opacity =
            Math.max(0, 1 - elapsed);

        if (elapsed > 1.5) {

            scene.remove(particles);

            geometry.dispose();
            material.dispose();

            return;
        }

        requestAnimationFrame(
            animate
        );
    }

    animate();
}

// =========================================================
// SMOKE
// =========================================================

export function spawnSmoke(
    scene,
    position,
    intensity = 1
) {
    if (typeof intensity === 'object' && intensity !== null) {
        intensity = intensity.density ?? 1;
    }

    const geometry =
        new THREE.SphereGeometry(
            0.3 * intensity,
            16,
            16
        );

    const material =
        new THREE.MeshBasicMaterial({

            color: 0x444444,

            transparent: true,

            opacity: 0.5
        });

    const smoke =
        new THREE.Mesh(
            geometry,
            material
        );

    smoke.position.copy(position);

    markEffectObject(smoke);
    scene.add(smoke);

    const start = performance.now();

    function animate() {

        const elapsed =
            (performance.now() - start)
            / 1000;

        smoke.scale.multiplyScalar(
            1.01
        );

        smoke.position.y += 0.003;

        material.opacity =
            Math.max(0, 0.5 - elapsed * 0.2);

        if (elapsed > 4) {

            scene.remove(smoke);

            geometry.dispose();
            material.dispose();

            return;
        }

        requestAnimationFrame(
            animate
        );
    }

    animate();
}

// =========================================================
// GAS CLOUD
// =========================================================

export function spawnGasCloud(
    scene,
    position,
    intensity = 1
) {
    if (typeof intensity === 'object' && intensity !== null) {
        intensity = intensity.toxicity ?? 1;
    }

    const geometry =
        new THREE.SphereGeometry(
            0.4 * intensity,
            20,
            20
        );

    const material =
        new THREE.MeshBasicMaterial({

            color: 0x66ff66,

            transparent: true,

            opacity: 0.35
        });

    const gas =
        new THREE.Mesh(
            geometry,
            material
        );

    gas.position.copy(position);

    markEffectObject(gas);
    scene.add(gas);

    const start = performance.now();

    function animate() {

        const elapsed =
            (performance.now() - start)
            / 1000;

        gas.scale.multiplyScalar(
            1.005
        );

        gas.position.y += 0.002;

        gas.rotation.y += 0.01;

        material.opacity =
            Math.max(0, 0.35 - elapsed * 0.05);

        if (elapsed > 8) {

            scene.remove(gas);

            geometry.dispose();
            material.dispose();

            return;
        }

        requestAnimationFrame(
            animate
        );
    }

    animate();
}

// =========================================================
// EXPLOSION / SHOCKWAVE
// =========================================================

export function createShockwave(
    scene,
    position,
    intensity = 1
) {
    if (typeof intensity === 'object' && intensity !== null) {
        intensity = intensity.power ?? 1;
    }

    const geometry =
        new THREE.SphereGeometry(
            0.3,
            32,
            32
        );

    const material =
        new THREE.MeshBasicMaterial({

            color: 0xffaa00,

            wireframe: true,

            transparent: true,

            opacity: 0.9
        });

    const shockwave =
        new THREE.Mesh(
            geometry,
            material
        );

    shockwave.position.copy(position);

    markEffectObject(shockwave);
    scene.add(shockwave);

    const start = performance.now();

    function animate() {

        const elapsed =
            (performance.now() - start)
            / 1000;

        const scale =
            1 + elapsed * 8 * intensity;

        shockwave.scale.set(
            scale,
            scale,
            scale
        );

        material.opacity =
            Math.max(0, 0.9 - elapsed * 2);

        if (elapsed > 1) {

            scene.remove(shockwave);

            geometry.dispose();
            material.dispose();

            return;
        }

        requestAnimationFrame(
            animate
        );
    }

    animate();
}

// =========================================================
// HEAT DISTORTION
// =========================================================

export function heatDistortion(
    scene,
    position,
    intensity = 1
) {
    if (typeof intensity === 'object' && intensity !== null) {
        intensity = intensity.strength ?? 1;
    }

    const geometry =
        new THREE.PlaneGeometry(
            1,
            1
        );

    const material =
        new THREE.MeshBasicMaterial({

            color: 0xffaa55,

            transparent: true,

            opacity: 0.08,

            side: THREE.DoubleSide
        });

    const heat =
        new THREE.Mesh(
            geometry,
            material
        );

    heat.position.copy(position);

    heat.rotation.x =
        -Math.PI / 2;

    markEffectObject(heat);
    scene.add(heat);

    const start = performance.now();

    function animate() {

        const elapsed =
            (performance.now() - start)
            / 1000;

        heat.scale.set(

            1 + Math.sin(elapsed * 15)
            * 0.1 * intensity,

            1,

            1 + Math.sin(elapsed * 15)
            * 0.1 * intensity
        );

        material.opacity =
            0.08 *
            Math.abs(
                Math.sin(elapsed * 10)
            );

        if (elapsed > 3) {

            scene.remove(heat);

            geometry.dispose();
            material.dispose();

            return;
        }

        requestAnimationFrame(
            animate
        );
    }

    animate();
}

// =========================================================
// PRECIPITATE
// =========================================================

export function spawnPrecipitate(
    scene,
    position,
    color = "#aee1ff"
) {
    const group = new THREE.Group();

    const particleCount = 80;

    for (let i = 0; i < particleCount; i++) {

        const geo = new THREE.SphereGeometry(
            0.01 + Math.random() * 0.015,
            6,
            6
        );

        const mat = new THREE.MeshStandardMaterial({
            color,
            roughness: 1
        });

        const p = new THREE.Mesh(geo, mat);

        p.position.set(
            position.x + (Math.random() - 0.5) * 0.12,
            position.y - Math.random() * 0.15,
            position.z + (Math.random() - 0.5) * 0.12
        );

        markEffectObject(p);
        group.add(p);
    }

    markEffectObject(group);
    scene.add(group);
}