import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

if (typeof window !== 'undefined' && window.DEBUG_CAVITY === undefined) {
    window.DEBUG_CAVITY = false;
}

const DEFAULT_INNER_SCALE = new THREE.Vector3(0.9, 0.95, 0.9);
const DEBUG_GROUP_NAME = 'cavity_csg_debug';
const SHELL_NAME = 'cavity_csg_shell';

function debugEnabled() {
    return typeof window !== 'undefined' && window.DEBUG_CAVITY === true;
}

function shouldIgnoreMesh(object) {
    const data = object?.userData || {};
    return (
        !object?.isMesh ||
        object.name === SHELL_NAME ||
        object.name === 'fluid_volume' ||
        data.isLiquid ||
        data.isPowder ||
        data.isParticle ||
        data.isReactionEffect ||
        data.isInternalChemicalVisual ||
        data.isCavityDebug ||
        data.isCSGCavityShell ||
        data.isCavitySourceMesh ||
        data.ignoreCavity
    );
}

function finiteVector3(value, fallback) {
    if (value?.isVector3) return value.clone();
    if (Array.isArray(value)) {
        return new THREE.Vector3(
            Number.isFinite(Number(value[0])) ? Number(value[0]) : fallback.x,
            Number.isFinite(Number(value[1])) ? Number(value[1]) : fallback.y,
            Number.isFinite(Number(value[2])) ? Number(value[2]) : fallback.z
        );
    }
    if (value && typeof value === 'object') {
        return new THREE.Vector3(
            Number.isFinite(Number(value.x)) ? Number(value.x) : fallback.x,
            Number.isFinite(Number(value.y)) ? Number(value.y) : fallback.y,
            Number.isFinite(Number(value.z)) ? Number(value.z) : fallback.z
        );
    }
    return fallback.clone();
}

function collectMeshes(root) {
    const meshes = [];
    root.traverse(object => {
        if (!shouldIgnoreMesh(object)) meshes.push(object);
    });
    return meshes;
}

function firstUsableMaterial(material) {
    if (Array.isArray(material)) return material.find(Boolean) || new THREE.MeshStandardMaterial();
    return material || new THREE.MeshStandardMaterial();
}

function bakeMeshGeometryToRoot(mesh, root, rootInverse) {
    if (!mesh.geometry?.attributes?.position) return null;

    const geometry = mesh.geometry.clone();
    const meshToRoot = rootInverse.clone().multiply(mesh.matrixWorld);
    geometry.applyMatrix4(meshToRoot);

    const position = geometry.getAttribute('position');
    if (!geometry.index) {
        geometry.setIndex(Array.from({ length: position.count }, (_, index) => index));
    }

    if (!geometry.getAttribute('normal')) {
        geometry.computeVertexNormals();
    }
    if (!geometry.getAttribute('uv')) {
        geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(position.count * 2), 2));
    }
    Object.keys(geometry.attributes).forEach(name => {
        if (!['position', 'normal', 'uv'].includes(name)) geometry.deleteAttribute(name);
    });
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    return geometry;
}

function buildMergedOuterGeometry(root) {
    root.updateMatrixWorld(true);
    const rootInverse = root.matrixWorld.clone().invert();
    const geometries = [];
    const materials = [];

    collectMeshes(root).forEach(mesh => {
        const geometry = bakeMeshGeometryToRoot(mesh, root, rootInverse);
        if (!geometry) return;
        geometries.push(geometry);
        materials.push(firstUsableMaterial(mesh.material));
    });

    if (!geometries.length) return null;

    let merged = geometries.length === 1
        ? geometries[0].clone()
        : mergeGeometries(geometries, true);

    geometries.forEach(geometry => geometry.dispose?.());

    if (!merged) return null;
    merged = mergeVertices(merged, 1e-5);
    merged.computeVertexNormals();
    merged.computeBoundingBox();
    merged.computeBoundingSphere();

    return {
        geometry: merged,
        material: materials.length === 1 ? materials[0] : materials
    };
}

function fitInnerTransform(outerBox, options = {}) {
    const size = outerBox.getSize(new THREE.Vector3());
    const center = outerBox.getCenter(new THREE.Vector3());
    const scale = finiteVector3(options.innerScale, DEFAULT_INNER_SCALE);
    scale.x = THREE.MathUtils.clamp(scale.x, 0.72, 0.98);
    scale.y = THREE.MathUtils.clamp(scale.y, 0.72, 0.98);
    scale.z = THREE.MathUtils.clamp(scale.z, 0.72, 0.98);

    const requestedBottom = Number.isFinite(Number(options.bottomThickness))
        ? Number(options.bottomThickness)
        : Math.max(size.y * 0.035, 0.012);
    const minTopClearance = Math.max(size.y * 0.008, 0.002);
    let halfYGap = size.y * (1 - scale.y) * 0.5;

    if (halfYGap < requestedBottom + minTopClearance) {
        scale.y = THREE.MathUtils.clamp(
            1 - (2 * (requestedBottom + minTopClearance)) / Math.max(size.y, 1e-6),
            0.72,
            0.98
        );
        halfYGap = size.y * (1 - scale.y) * 0.5;
    }

    const bottomThickness = THREE.MathUtils.clamp(
        requestedBottom,
        Math.max(size.y * 0.004, 0.001),
        Math.max(halfYGap - minTopClearance, size.y * 0.004)
    );

    const transform = new THREE.Matrix4()
        .makeTranslation(0, bottomThickness, 0)
        .multiply(new THREE.Matrix4().makeTranslation(center.x, center.y, center.z))
        .multiply(new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z))
        .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));

    return { transform, scale, bottomThickness, center, size };
}

function createInnerGeometry(outerGeometry, outerBox, options = {}) {
    const { transform, scale, bottomThickness, center, size } = fitInnerTransform(outerBox, options);
    const geometry = outerGeometry.clone();
    geometry.applyMatrix4(transform);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const innerBox = geometry.boundingBox.clone();
    const epsilon = Math.max(size.length() * 1e-4, 1e-4);
    const correction = new THREE.Vector3();

    if (innerBox.min.x < outerBox.min.x + epsilon) correction.x += (outerBox.min.x + epsilon) - innerBox.min.x;
    if (innerBox.max.x > outerBox.max.x - epsilon) correction.x -= innerBox.max.x - (outerBox.max.x - epsilon);
    if (innerBox.min.y < outerBox.min.y + epsilon) correction.y += (outerBox.min.y + epsilon) - innerBox.min.y;
    if (innerBox.max.y > outerBox.max.y - epsilon) correction.y -= innerBox.max.y - (outerBox.max.y - epsilon);
    if (innerBox.min.z < outerBox.min.z + epsilon) correction.z += (outerBox.min.z + epsilon) - innerBox.min.z;
    if (innerBox.max.z > outerBox.max.z - epsilon) correction.z -= innerBox.max.z - (outerBox.max.z - epsilon);

    if (correction.lengthSq() > 0) {
        geometry.translate(correction.x, correction.y, correction.z);
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
    }

    return {
        geometry,
        scale,
        bottomThickness,
        center,
        beforeBox: outerBox.clone(),
        afterBox: geometry.boundingBox.clone()
    };
}

function sampleCavityPoints(innerGeometry, options = {}) {
    innerGeometry.computeBoundingBox();
    const box = innerGeometry.boundingBox;
    if (!box || box.isEmpty()) return [];

    const size = box.getSize(new THREE.Vector3());
    const grid = THREE.MathUtils.clamp(Number(options.grid) || 30, 12, 44);
    const raycaster = new THREE.Raycaster();
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(innerGeometry, material);
    mesh.updateMatrixWorld(true);

    const points = [];
    const rayPad = Math.max(size.y * 0.08, 0.02);
    const minDepth = Math.max(size.y * 0.035, 0.01);

    for (let ix = 0; ix < grid; ix++) {
        for (let iz = 0; iz < grid; iz++) {
            const lx = THREE.MathUtils.lerp(box.min.x, box.max.x, (ix + 0.5) / grid);
            const lz = THREE.MathUtils.lerp(box.min.z, box.max.z, (iz + 0.5) / grid);
            raycaster.set(
                new THREE.Vector3(lx, box.max.y + rayPad, lz),
                new THREE.Vector3(0, -1, 0)
            );

            const hits = raycaster.intersectObject(mesh, false);
            if (hits.length < 2) continue;

            const top = hits[0].point.y;
            const bottom = hits[hits.length - 1].point.y;
            if (!Number.isFinite(top) || !Number.isFinite(bottom) || top - bottom < minDepth) continue;

            points.push({
                lx,
                lz,
                lyTop: top,
                lyBottom: bottom,
                source: 'csg_inner',
                gridX: ix,
                gridZ: iz
            });
        }
    }

    material.dispose();
    return points;
}

function uniqueHitsByY(hits, epsilon = 1e-4) {
    const unique = [];
    hits.forEach(hit => {
        if (!Number.isFinite(hit?.point?.y)) return;
        if (unique.some(existing => Math.abs(existing.point.y - hit.point.y) <= epsilon)) return;
        unique.push(hit);
    });
    return unique;
}

function sampleOpenCavityPointsFromShell(shellGeometry, innerBox, outerBox, options = {}) {
    shellGeometry.computeBoundingBox();
    const box = innerBox?.isBox3 ? innerBox : shellGeometry.boundingBox;
    if (!box || box.isEmpty()) return [];

    const size = box.getSize(new THREE.Vector3());
    const outerSize = outerBox.getSize(new THREE.Vector3());
    const grid = THREE.MathUtils.clamp(Number(options.openGrid) || Number(options.grid) || 34, 16, 52);
    const raycaster = new THREE.Raycaster();
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(shellGeometry, material);
    mesh.updateMatrixWorld(true);

    const points = [];
    const rayPad = Math.max(outerSize.y * 0.12, 0.04);
    const topY = box.max.y - Math.max(size.y * 0.035, 0.006);
    const topHitGate = box.min.y + size.y * 0.72;
    const bottomClearance = Math.max(size.y * 0.018, 0.006);
    const minColumnHeight = Math.max(size.y * 0.18, 0.035);
    const hitEpsilon = Math.max(outerSize.length() * 1e-4, 1e-4);

    for (let ix = 0; ix < grid; ix++) {
        for (let iz = 0; iz < grid; iz++) {
            const lx = THREE.MathUtils.lerp(box.min.x, box.max.x, (ix + 0.5) / grid);
            const lz = THREE.MathUtils.lerp(box.min.z, box.max.z, (iz + 0.5) / grid);
            raycaster.set(
                new THREE.Vector3(lx, outerBox.max.y + rayPad, lz),
                new THREE.Vector3(0, -1, 0)
            );

            const hits = uniqueHitsByY(raycaster.intersectObject(mesh, false), hitEpsilon);
            if (!hits.length) continue;

            const firstY = hits[0].point.y;
            if (!Number.isFinite(firstY)) continue;

            // If the first surface is high, the ray is hitting rim/handle/top wall, not open cavity.
            if (firstY > topHitGate) continue;

            const bottom = Math.max(firstY + bottomClearance, box.min.y + bottomClearance);
            if (topY - bottom < minColumnHeight) continue;

            points.push({
                lx,
                lz,
                lyTop: topY,
                lyBottom: bottom,
                source: 'csg_shell_open',
                gridX: ix,
                gridZ: iz
            });
        }
    }

    material.dispose();
    return points;
}

function fallbackCavityPointsFromBox(box) {
    const size = box.getSize(new THREE.Vector3());
    const points = [];
    const grid = 18;
    const insetX = size.x * 0.08;
    const insetZ = size.z * 0.08;
    const bottom = box.min.y + size.y * 0.04;
    const top = box.max.y - size.y * 0.04;

    for (let ix = 0; ix < grid; ix++) {
        for (let iz = 0; iz < grid; iz++) {
            points.push({
                lx: THREE.MathUtils.lerp(box.min.x + insetX, box.max.x - insetX, (ix + 0.5) / grid),
                lz: THREE.MathUtils.lerp(box.min.z + insetZ, box.max.z - insetZ, (iz + 0.5) / grid),
                lyTop: top,
                lyBottom: bottom,
                source: 'csg_inner_box'
            });
        }
    }

    return points;
}

function quantile(values, ratio) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const index = THREE.MathUtils.clamp(
        Math.round((sorted.length - 1) * ratio),
        0,
        sorted.length - 1
    );
    return sorted[index];
}

function gridKey(x, z) {
    return `${x},${z}`;
}

function neighborCount(point, map) {
    let count = 0;
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dz === 0) continue;
            if (map.has(gridKey(point.gridX + dx, point.gridZ + dz))) count++;
        }
    }
    return count;
}

function erodePointMap(map, minDegree) {
    const eroded = new Map();
    map.forEach((point, key) => {
        if (neighborCount(point, map) >= minDegree) eroded.set(key, point);
    });
    return eroded;
}

function dilateComponent(component, sourceMap, radius, predicate = null) {
    const selected = new Map();
    component.forEach(point => {
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                const key = gridKey(point.gridX + dx, point.gridZ + dz);
                const candidate = sourceMap.get(key);
                if (!candidate || selected.has(key)) continue;
                if (predicate && !predicate(candidate)) continue;
                selected.set(key, candidate);
            }
        }
    });
    return Array.from(selected.values());
}

function componentsFromPointMap(map) {
    const visited = new Set();
    const components = [];
    const neighborOffsets = [
        [-1, -1], [0, -1], [1, -1],
        [-1, 0],           [1, 0],
        [-1, 1],  [0, 1],  [1, 1]
    ];

    for (const [key, start] of map.entries()) {
        if (visited.has(key)) continue;
        const component = [];
        const queue = [start];
        visited.add(key);

        while (queue.length > 0) {
            const point = queue.pop();
            component.push(point);
            for (const [dx, dz] of neighborOffsets) {
                const nextKey = gridKey(point.gridX + dx, point.gridZ + dz);
                if (visited.has(nextKey) || !map.has(nextKey)) continue;
                visited.add(nextKey);
                queue.push(map.get(nextKey));
            }
        }

        components.push(component);
    }

    return components;
}

function componentGridBox(component) {
    const box = {
        minX: Infinity,
        maxX: -Infinity,
        minZ: Infinity,
        maxZ: -Infinity
    };
    component.forEach(point => {
        box.minX = Math.min(box.minX, point.gridX);
        box.maxX = Math.max(box.maxX, point.gridX);
        box.minZ = Math.min(box.minZ, point.gridZ);
        box.maxZ = Math.max(box.maxZ, point.gridZ);
    });
    return box;
}

function denseMainFootprint(points, keyed) {
    const depths = points.map(point => point.lyTop - point.lyBottom);
    const tops = points.map(point => point.lyTop);
    const maxDepth = Math.max(...depths);
    const minDepth = Math.max(maxDepth * 0.32, quantile(depths, 0.5) * 0.76);
    const minTop = quantile(tops, 0.34);

    const candidate = new Map();
    points.forEach(point => {
        const depth = point.lyTop - point.lyBottom;
        if (depth >= minDepth && point.lyTop >= minTop) {
            candidate.set(gridKey(point.gridX, point.gridZ), point);
        }
    });
    if (candidate.size < Math.max(12, keyed.size * 0.12)) return null;

    let minDegree = candidate.size > 180 ? 5 : 4;
    let dense = erodePointMap(candidate, minDegree);

    if (dense.size < Math.max(10, candidate.size * 0.18)) {
        minDegree = candidate.size > 180 ? 4 : 3;
        dense = erodePointMap(candidate, minDegree);
    }

    if (dense.size >= Math.max(18, candidate.size * 0.22)) {
        const secondPass = erodePointMap(dense, candidate.size > 180 ? 4 : 3);
        if (secondPass.size >= Math.max(10, dense.size * 0.28)) {
            dense = secondPass;
        }
    }
    if (dense.size < Math.max(10, candidate.size * 0.12)) return null;

    const components = componentsFromPointMap(dense);
    if (!components.length) return null;

    const globalBox = new THREE.Box3();
    points.forEach(point => globalBox.expandByPoint(new THREE.Vector3(point.lx, 0, point.lz)));
    const globalCenter = globalBox.getCenter(new THREE.Vector3());
    const globalSize = globalBox.getSize(new THREE.Vector3());
    const globalRadius = Math.max(globalSize.x, globalSize.z, 1e-4) * 0.5;

    let best = null;
    let bestScore = -Infinity;
    for (const component of components) {
        const pointBox = new THREE.Box3();
        let depthSum = 0;
        component.forEach(point => {
            pointBox.expandByPoint(new THREE.Vector3(point.lx, 0, point.lz));
            depthSum += point.lyTop - point.lyBottom;
        });
        const size = pointBox.getSize(new THREE.Vector3());
        const gridBox = componentGridBox(component);
        const bboxCells = Math.max(1, (gridBox.maxX - gridBox.minX + 1) * (gridBox.maxZ - gridBox.minZ + 1));
        const density = component.length / bboxCells;
        const compactness = Math.min(size.x, size.z) / Math.max(size.x, size.z, 1e-4);
        const center = pointBox.getCenter(new THREE.Vector3());
        const centerDistance = center.distanceTo(globalCenter) / globalRadius;
        const centerWeight = 1 / (1 + centerDistance * centerDistance);
        const depthWeight = THREE.MathUtils.clamp((depthSum / component.length) / Math.max(maxDepth, 1e-4), 0.25, 1.4);
        const score = component.length * (0.5 + density) * (0.4 + compactness) * (0.5 + depthWeight) * centerWeight;

        if (score > bestScore) {
            bestScore = score;
            best = component;
        }
    }

    if (!best) return null;

    const pad = best.length > 80 ? 2 : 1;
    const selected = dilateComponent(best, keyed, pad, point => {
        const depth = point.lyTop - point.lyBottom;
        return depth >= minDepth * 0.62 && point.lyTop >= minTop;
    });

    if (selected.length < Math.max(10, best.length * 0.85)) return null;

    if (debugEnabled()) {
        console.log('[CAVITY_CSG] dense main footprint', {
            inputPoints: points.length,
            candidatePoints: candidate.size,
            densePoints: dense.size,
            selectedPoints: selected.length,
            droppedPoints: points.length - selected.length,
            components: components.length,
            minDegree
        });
    }

    return selected;
}

export function selectDominantCavityPoints(points = [], options = {}) {
    const valid = points.filter(point =>
        Number.isFinite(point?.lx) &&
        Number.isFinite(point?.lz) &&
        Number.isFinite(point?.lyTop) &&
        Number.isFinite(point?.lyBottom) &&
        point.lyTop > point.lyBottom
    );
    if (valid.length < 20) return valid;

    const keyed = new Map();
    for (const point of valid) {
        if (Number.isInteger(point.gridX) && Number.isInteger(point.gridZ)) {
            keyed.set(gridKey(point.gridX, point.gridZ), point);
        }
    }
    if (keyed.size < Math.max(12, valid.length * 0.35)) return valid;

    const denseMain = denseMainFootprint(valid, keyed);
    if (denseMain && denseMain.length >= Math.max(10, valid.length * 0.05)) return denseMain;

    const globalBox = new THREE.Box3();
    let maxDepth = 0;
    let minTop = Infinity;
    let maxTop = -Infinity;
    valid.forEach(point => {
        globalBox.expandByPoint(new THREE.Vector3(point.lx, 0, point.lz));
        maxDepth = Math.max(maxDepth, point.lyTop - point.lyBottom);
        minTop = Math.min(minTop, point.lyTop);
        maxTop = Math.max(maxTop, point.lyTop);
    });
    const globalCenter = globalBox.getCenter(new THREE.Vector3());
    const globalSize = globalBox.getSize(new THREE.Vector3());
    const globalRadius = Math.max(globalSize.x, globalSize.z, 1e-4) * 0.5;

    const components = componentsFromPointMap(keyed);

    if (components.length <= 1) return valid;

    const minKeep = Math.max(10, Math.floor(valid.length * 0.035));
    let best = null;
    let bestScore = -Infinity;

    for (const component of components) {
        if (component.length < minKeep) continue;

        const box = new THREE.Box3();
        let minGridX = Infinity;
        let maxGridX = -Infinity;
        let minGridZ = Infinity;
        let maxGridZ = -Infinity;
        let depthSum = 0;
        let topSum = 0;

        component.forEach(point => {
            box.expandByPoint(new THREE.Vector3(point.lx, 0, point.lz));
            minGridX = Math.min(minGridX, point.gridX);
            maxGridX = Math.max(maxGridX, point.gridX);
            minGridZ = Math.min(minGridZ, point.gridZ);
            maxGridZ = Math.max(maxGridZ, point.gridZ);
            depthSum += point.lyTop - point.lyBottom;
            topSum += point.lyTop;
        });

        const size = box.getSize(new THREE.Vector3());
        const bboxCells = Math.max(1, (maxGridX - minGridX + 1) * (maxGridZ - minGridZ + 1));
        const density = component.length / bboxCells;
        const roundness = Math.min(size.x, size.z) / Math.max(size.x, size.z, 1e-4);
        const avgDepth = depthSum / component.length;
        const avgTop = topSum / component.length;
        const depthWeight = THREE.MathUtils.clamp(avgDepth / Math.max(maxDepth, 1e-4), 0.25, 1.5);
        const topWeight = Number.isFinite(minTop) && maxTop > minTop
            ? THREE.MathUtils.clamp((avgTop - minTop) / (maxTop - minTop), 0, 1)
            : 0.5;
        const center = box.getCenter(new THREE.Vector3());
        const centerDistance = center.distanceTo(globalCenter) / globalRadius;
        const centerWeight = 1 / (1 + centerDistance * centerDistance * 1.2);
        const score = component.length *
            (0.35 + density) *
            (0.35 + roundness) *
            (0.45 + depthWeight) *
            (0.65 + topWeight) *
            centerWeight;

        if (score > bestScore) {
            bestScore = score;
            best = component;
        }
    }

    const selected = best || components.reduce((largest, component) =>
        component.length > largest.length ? component : largest, components[0]);

    if (debugEnabled()) {
        console.log('[CAVITY_CSG] dominant component', {
            components: components.length,
            inputPoints: valid.length,
            selectedPoints: selected.length,
            droppedPoints: valid.length - selected.length,
            score: bestScore
        });
    }

    return selected.length >= minKeep ? selected : valid;
}

function disposeMaterial(material) {
    if (Array.isArray(material)) material.forEach(item => item?.dispose?.());
    else material?.dispose?.();
}

function restoreSourceMeshes(root) {
    root.traverse(object => {
        if (!object?.isMesh || !object.userData?.isCavitySourceMesh) return;
        object.visible = true;
        delete object.userData.isCavitySourceMesh;
        delete object.userData.ignoreCavity;
        if (object.userData.isCSGCavityShell !== true) {
            delete object.userData.ignoreRaycast;
        }
    });
}

function removeExistingShell(root) {
    const existing = root.getObjectByName?.(SHELL_NAME);
    if (!existing) return;
    existing.parent?.remove(existing);
    existing.geometry?.dispose?.();
    disposeMaterial(existing.material);
}

function clearDebug(root) {
    const existing = root.getObjectByName?.(DEBUG_GROUP_NAME);
    if (!existing) return;
    existing.traverse(child => {
        if (child !== existing) {
            child.geometry?.dispose?.();
            disposeMaterial(child.material);
        }
    });
    existing.parent?.remove(existing);
}

function addDebugMesh(group, name, geometry, material) {
    const mesh = new THREE.Mesh(geometry.clone(), material);
    mesh.name = name;
    mesh.userData.isCavityDebug = true;
    mesh.userData.ignoreRaycast = true;
    mesh.userData.notDraggable = true;
    mesh.raycast = () => null;
    group.add(mesh);
    return mesh;
}

function attachDebug(root, outerGeometry, innerGeometry, resultGeometry) {
    clearDebug(root);
    if (!debugEnabled()) return;

    const group = new THREE.Group();
    group.name = DEBUG_GROUP_NAME;
    group.userData.isCavityDebug = true;
    group.userData.ignoreRaycast = true;
    group.userData.notDraggable = true;

    addDebugMesh(group, 'cavity_outer_wire', outerGeometry, new THREE.MeshBasicMaterial({
        color: 0x1d4ed8,
        wireframe: true,
        transparent: true,
        opacity: 0.62,
        depthWrite: false
    }));
    addDebugMesh(group, 'cavity_inner_wire', innerGeometry, new THREE.MeshBasicMaterial({
        color: 0xdc2626,
        wireframe: true,
        transparent: true,
        opacity: 0.7,
        depthWrite: false
    }));
    addDebugMesh(group, 'cavity_result_transparent', resultGeometry, new THREE.MeshBasicMaterial({
        color: 0xfacc15,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide
    }));

    root.add(group);
}

function logDebug(label, payload) {
    if (debugEnabled()) console.log(label, payload);
}

export async function buildContainerCavityCSG(root, options = {}) {
    if (!root?.userData || root.userData.toolType !== 'container') return null;

    root.updateMatrixWorld(true);
    removeExistingShell(root);
    clearDebug(root);
    restoreSourceMeshes(root);

    const merged = buildMergedOuterGeometry(root);
    if (!merged?.geometry) return null;

    const outerGeometry = merged.geometry;
    outerGeometry.computeBoundingBox();
    const outerBox = outerGeometry.boundingBox.clone();
    const inner = createInnerGeometry(outerGeometry, outerBox, options);
    const innerSamplePoints = selectDominantCavityPoints(sampleCavityPoints(inner.geometry, options), options);
    const outerOpenPoints = selectDominantCavityPoints(
        sampleOpenCavityPointsFromShell(outerGeometry, inner.afterBox, outerBox, options),
        options
    );
    let cavityPoints = outerOpenPoints.length >= Math.max(14, innerSamplePoints.length * 0.08)
        ? outerOpenPoints
        : innerSamplePoints;
    if (!cavityPoints.length) cavityPoints = fallbackCavityPointsFromBox(inner.afterBox);

    logDebug('[CAVITY_CSG] before CSG', {
        tool: root.name || root.userData?.toolData?.name_tool_en || 'container',
        scale: inner.scale.toArray(),
        bottomThickness: inner.bottomThickness,
        outerBox: {
            min: outerBox.min.toArray(),
            max: outerBox.max.toArray()
        },
        innerBox: {
            min: inner.afterBox.min.toArray(),
            max: inner.afterBox.max.toArray()
        },
        points: cavityPoints.length
    });

    let outerBrush = null;
    let innerBrush = null;
    let result = null;

    try {
        const { Brush, Evaluator, SUBTRACTION } = await import('three-bvh-csg');
        outerBrush = new Brush(outerGeometry.clone(), merged.material);
        innerBrush = new Brush(inner.geometry.clone(), merged.material);
        outerBrush.updateMatrixWorld(true);
        innerBrush.updateMatrixWorld(true);
        outerBrush.geometry.computeVertexNormals();
        innerBrush.geometry.computeVertexNormals();

        const evaluator = new Evaluator();
        evaluator.attributes = ['position', 'normal', 'uv'];
        evaluator.useGroups = true;
        evaluator.consolidateMaterials = false;

        result = evaluator.evaluate(outerBrush, innerBrush, SUBTRACTION);
        result.geometry.computeVertexNormals();
        result.geometry.computeBoundingBox();
        result.geometry.computeBoundingSphere();

        const openShellPoints = selectDominantCavityPoints(
            sampleOpenCavityPointsFromShell(result.geometry, inner.afterBox, outerBox, options),
            options
        );
        if (openShellPoints.length >= Math.max(14, innerSamplePoints.length * 0.08)) {
            cavityPoints = openShellPoints;
        }
        if (!cavityPoints.length) cavityPoints = fallbackCavityPointsFromBox(inner.afterBox);

        root.userData.cavityPoints = cavityPoints;
        root.userData.cavitySource = 'csg_scaled_model';
        root.userData.cavityCSG = {
            innerScale: inner.scale.toArray(),
            bottomThickness: inner.bottomThickness,
            pointCount: cavityPoints.length,
            pointSource: cavityPoints[0]?.source || 'unknown',
            innerSamplePointCount: innerSamplePoints.length,
            outerOpenPointCount: outerOpenPoints.length,
            openShellPointCount: openShellPoints.length,
            outerBox: outerBox.clone(),
            innerBox: inner.afterBox.clone(),
            resultBox: result.geometry.boundingBox.clone(),
            renderMode: 'metadata_only'
        };
        root.userData.cavityBox = inner.afterBox.clone();

        delete root.userData.outerMesh;
        delete root.userData.cavityShell;

        attachDebug(root, outerGeometry, inner.geometry, result.geometry);
        logDebug('[CAVITY_CSG] after CSG', {
            tool: root.name || root.userData?.toolData?.name_tool_en || 'container',
            resultBox: {
                min: result.geometry.boundingBox.min.toArray(),
                max: result.geometry.boundingBox.max.toArray()
            },
            resultSphere: {
                center: result.geometry.boundingSphere.center.toArray(),
                radius: result.geometry.boundingSphere.radius
            }
        });

        return root.userData.cavityShell || null;
    } catch (error) {
        console.warn('[CAVITY_CSG] CSG failed, keeping original mesh and using scaled-model cavity metadata:', error);
        removeExistingShell(root);
        clearDebug(root);
        restoreSourceMeshes(root);
        root.userData.cavityPoints = cavityPoints;
        root.userData.cavitySource = 'csg_scaled_model';
        root.userData.cavityCSG = {
            innerScale: inner.scale.toArray(),
            bottomThickness: inner.bottomThickness,
            pointCount: cavityPoints.length,
            pointSource: cavityPoints[0]?.source || 'unknown',
            innerSamplePointCount: innerSamplePoints.length,
            outerOpenPointCount: outerOpenPoints.length,
            outerBox: outerBox.clone(),
            innerBox: inner.afterBox.clone(),
            csgFailed: true
        };
        root.userData.cavityBox = inner.afterBox.clone();
        attachDebug(root, outerGeometry, inner.geometry, outerGeometry);
        return null;
    } finally {
        if (!debugEnabled()) clearDebug(root);
        outerBrush?.geometry?.dispose?.();
        innerBrush?.geometry?.dispose?.();
        result?.geometry?.dispose?.();
        outerGeometry.dispose?.();
        inner.geometry.dispose?.();
    }
}
