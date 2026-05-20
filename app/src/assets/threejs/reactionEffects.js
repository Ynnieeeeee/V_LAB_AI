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

    if (effects.foam) {
        spawnFoam(scene, position, effects.foam);
    }

    if (effects.decolorize) {
        decolorizeLiquid(effects.container || effects.target || null);
    }

    if (effects.phaseSeparation || effects.twoLayerLiquid) {
        phaseSeparation(effects.container || effects.target || null, effects.phaseSeparation || effects);
    }

    if (effects.mirrorSilver || effects.mirrorCoating) {
        mirrorSilver(effects.container || effects.target || null);
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

export function spawnFoam(scene, position, intensity = 1) {
    if (typeof intensity === 'object' && intensity !== null) {
        intensity = intensity.intensity ?? 1;
    }
    const group = new THREE.Group();
    group.name = 'foam_reaction_effect';
    const count = Math.floor(36 * Math.max(0.5, intensity));
    for (let i = 0; i < count; i++) {
        const geometry = new THREE.SphereGeometry(0.018 + Math.random() * 0.025, 8, 8);
        const material = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.55
        });
        const bubble = new THREE.Mesh(geometry, material);
        bubble.position.set(
            position.x + (Math.random() - 0.5) * 0.22,
            position.y + Math.random() * 0.08,
            position.z + (Math.random() - 0.5) * 0.22
        );
        markEffectObject(bubble);
        group.add(bubble);
    }
    markEffectObject(group);
    scene.add(group);

    const start = performance.now();
    function animate() {
        const elapsed = (performance.now() - start) / 1000;
        group.position.y += 0.002;
        group.traverse(child => {
            if (child.material) child.material.opacity = Math.max(0, 0.55 - elapsed * 0.22);
        });
        if (elapsed > 2.5) {
            scene.remove(group);
            group.traverse(child => {
                child.geometry?.dispose?.();
                child.material?.dispose?.();
            });
            return;
        }
        requestAnimationFrame(animate);
    }
    animate();
    return group;
}

export function dissolvePrecipitate(container) {
    const layer = container?.getObjectByName?.('precipitateLayer');
    if (!layer) return false;
    layer.traverse?.(child => {
        child.geometry?.dispose?.();
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose?.());
        else child.material?.dispose?.();
    });
    layer.parent?.remove(layer);
    if (container?.userData) {
        container.userData.hasPrecipitate = false;
        container.userData.precipitateColor = null;
        container.userData.precipitateSpecies = null;
    }
    return true;
}

export function mirrorSilver(container) {
    if (!container) return null;
    const existing = container.getObjectByName?.('silverMirrorLayer');
    if (existing) existing.parent?.remove(existing);

    container.updateMatrixWorld?.(true);
    const box = new THREE.Box3().setFromObject(container);
    const inv = container.matrixWorld.clone().invert();
    const min = box.min.clone().applyMatrix4(inv);
    const max = box.max.clone().applyMatrix4(inv);
    const radius = Math.max(0.045, Math.abs(max.x - min.x) * 0.28);
    const depthScale = Math.max(0.65, Math.abs(max.z - min.z) / Math.max(Math.abs(max.x - min.x), 0.001));
    const height = Math.max(0.08, Math.abs(max.y - min.y) * 0.32);

    const layer = new THREE.Group();
    layer.name = 'silverMirrorLayer';
    const geometry = new THREE.CylinderGeometry(radius, radius * 0.95, height, 48, 1, true);
    geometry.scale(1, 1, depthScale);
    const material = new THREE.MeshPhysicalMaterial({
        color: '#dfe4ea',
        metalness: 1.0,
        roughness: 0.0,
        transparent: true,
        opacity: 0.74,
        side: THREE.DoubleSide,
        envMapIntensity: 2.0
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'silver_mirror_inner_wall';
    mesh.position.set((min.x + max.x) * 0.5, min.y + height * 0.72, (min.z + max.z) * 0.5);
    markEffectObject(mesh);
    layer.add(mesh);
    markEffectObject(layer);
    container.add(layer);
    container.userData.hasSilverMirror = true;
    return layer;
}

export function phaseSeparation(container, options = {}) {
    if (!container?.userData) return false;
    const existing = container.getObjectByName?.('phaseSeparationLayer');
    if (existing) {
        existing.traverse?.(child => {
            child.geometry?.dispose?.();
            if (Array.isArray(child.material)) child.material.forEach(m => m.dispose?.());
            else child.material?.dispose?.();
        });
        existing.parent?.remove(existing);
    }

    container.userData.twoLayerLiquid = true;
    container.userData.phaseSeparated = true;
    container.userData.upperLayerColor = options.upperColor || '#fff4c2';
    container.userData.lowerLayerColor = options.lowerColor || '#f8f8ff';

    container.updateMatrixWorld?.(true);
    const box = new THREE.Box3().setFromObject(container);
    const inv = container.matrixWorld.clone().invert();
    const min = box.min.clone().applyMatrix4(inv);
    const max = box.max.clone().applyMatrix4(inv);
    const sizeX = Math.max(0.06, Math.abs(max.x - min.x) * 0.34);
    const sizeZ = Math.max(0.06, Math.abs(max.z - min.z) * 0.34);
    const h = Math.max(0.035, Math.abs(max.y - min.y) * 0.07);
    const centerX = (min.x + max.x) * 0.5;
    const centerZ = (min.z + max.z) * 0.5;
    const baseY = min.y + Math.abs(max.y - min.y) * 0.24;

    const layer = new THREE.Group();
    layer.name = 'phaseSeparationLayer';
    const makeLayer = (color, y, opacity) => {
        const geo = new THREE.CylinderGeometry(sizeX, sizeX, h, 48);
        geo.scale(1, 1, sizeZ / sizeX);
        const mat = new THREE.MeshPhysicalMaterial({
            color,
            transparent: true,
            opacity,
            roughness: 0.15,
            metalness: 0,
            transmission: 0.25,
            depthWrite: false
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(centerX, y, centerZ);
        markEffectObject(mesh);
        return mesh;
    };
    layer.add(makeLayer(container.userData.lowerLayerColor, baseY, 0.32));
    layer.add(makeLayer(container.userData.upperLayerColor, baseY + h * 1.15, 0.46));
    markEffectObject(layer);
    container.add(layer);

    const volume = container.getObjectByName?.('fluid_volume');
    if (volume?.userData) {
        volume.userData.twoLayerLiquid = true;
        volume.userData.upperLayerColor = container.userData.upperLayerColor;
        volume.userData.lowerLayerColor = container.userData.lowerLayerColor;
    }
    return true;
}

export function decolorizeLiquid(container, color = '#ffffff') {
    if (!container?.userData) return false;
    container.userData.liquidColor = new THREE.Color(color);
    container.userData.color = color;
    const volume = container.getObjectByName?.('fluid_volume');
    if (volume?.material) {
        volume.material.color.set(color);
        volume.material.emissive?.set?.(0x000000);
        volume.material.needsUpdate = true;
    }
    return true;
}
