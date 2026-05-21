import * as THREE from 'three';
import { markContainerHeated } from './ExperimentSessionManager.js';

function getCenter(object) {
    const box = new THREE.Box3().setFromObject(object);
    const center = new THREE.Vector3();
    box.getCenter(center);
    return center;
}

function isActiveHeatingSource(source) {
    return Boolean(
        source?.userData?.isHeatingSource === true &&
        source.userData.isToggleable === true &&
        source.userData.isOn === true
    );
}

function isHeatTarget(target) {
    return target?.userData?.toolType === 'container';
}

export class HeatingManager {
    constructor(scene, options = {}) {
        this.scene = scene;
        this.getObjects = options.getObjects || (() => []);
        this.heatingRadius = Number(options.heatingRadius || 0.85);
        this.minTemperature = Number(options.minTemperature || 25);
        this.lastDebugAt = 0;
    }

    setObjectsProvider(getObjects) {
        this.getObjects = getObjects || (() => []);
    }

    update(delta = 1 / 60) {
        const objects = this.getObjects().filter(Boolean);
        const sources = objects.filter(isActiveHeatingSource);
        if (!sources.length) return;

        const containers = objects.filter(target => isHeatTarget(target) && !sources.includes(target));
        if (!containers.length) return;

        sources.forEach(source => {
            const sourceCenter = getCenter(source);
            containers.forEach(target => {
                const targetCenter = getCenter(target);
                const distance = sourceCenter.distanceTo(targetCenter);
                if (distance > this.heatingRadius) return;

                const heatPower = Math.max(0, Number(source.userData.heatingPower || 0));
                const maxTemperature = Math.max(this.minTemperature, Number(source.userData.maxTemperature || this.minTemperature));
                const currentTemperature = Number(target.userData.currentTemperature ?? target.userData.temperature ?? this.minTemperature);
                const proximity = Math.max(0.15, 1 - distance / this.heatingRadius);
                const nextTemperature = Math.min(maxTemperature, currentTemperature + heatPower * delta * proximity);

                if (nextTemperature <= currentTemperature) return;
                markContainerHeated(target, Number(nextTemperature.toFixed(2)));

                const now = performance.now();
                if (now - this.lastDebugAt > 1000) {
                    console.debug('[HeatingManager] heating container', {
                        source: source.userData.toolData?.name_tool_vi || source.userData.toolData?.name_tool_en,
                        target: target.userData.toolData?.name_tool_vi || target.userData.toolData?.name_tool_en,
                        distance: Number(distance.toFixed(3)),
                        heatingPower: heatPower,
                        maxTemperature,
                        currentTemperature: Number(nextTemperature.toFixed(2))
                    });
                    this.lastDebugAt = now;
                }
            });
        });
    }
}

export function createHeatingManager(scene, options = {}) {
    return new HeatingManager(scene, options);
}

export function canToggleHeatingSource(object) {
    return Boolean(object?.userData?.isHeatingSource === true && object.userData.isToggleable === true);
}

export function toggleHeatingSource(object) {
    if (!canToggleHeatingSource(object)) {
        console.warn('[HeatingManager] Object is not a toggleable heating source:', object?.userData?.toolData);
        return false;
    }
    object.userData.isOn = !object.userData.isOn;
    console.debug('[HeatingManager] toggled heating source', {
        name: object.userData.toolData?.name_tool_vi || object.userData.toolData?.name_tool_en,
        isOn: object.userData.isOn,
        heatingPower: object.userData.heatingPower,
        maxTemperature: object.userData.maxTemperature
    });
    return true;
}
