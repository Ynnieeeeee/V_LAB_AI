import * as THREE from 'three';
import { PrecipitateSystem } from './PrecipitateSystem.js';
import { GasEmitter } from './GasEmitter.js';
import { PowderSystem } from './PowderSystem.js';
import {
    spawnFireParticles,
    spawnSmoke,
    spawnGasCloud,
    createShockwave,
    heatDistortion
} from './reactionEffects.js';

/**
 * ReactionManager
 * Trung tâm render phản ứng:
 * - Kết tủa: gắn vào container local-space.
 * - Bột/rắn: dùng PowderSystem, không dùng liquid MarchingCubes.
 * - Khí/khói/cháy/nổ/nhiệt: world-space từ miệng dụng cụ.
 */
export class ReactionManager {
    constructor(scene, options = {}) {
        this.scene = scene;
        this.precipitateSystem = options.precipitateSystem || new PrecipitateSystem(scene);
        this.gasEmitter = options.gasEmitter || new GasEmitter(scene);
        this.powderSystem = options.powderSystem || new PowderSystem(scene);
        this.clock = new THREE.Clock();
    }

    normalizeIntensity(value, fallback = 1) {
        if (value === true) return fallback;
        if (typeof value === 'number') return value;
        if (typeof value === 'object' && value !== null) {
            return value.intensity ?? value.power ?? value.strength ?? value.density ?? fallback;
        }
        return 0;
    }

    normalizeReaction(reaction = {}) {
        const visual = reaction.visual || {};
        const effects = reaction.effects || {};
        return {
            hasReaction: Boolean(reaction.has_reaction ?? reaction.hasReaction ?? reaction.has_reaction === undefined),
            color: reaction.color || visual.result_color || visual.color,
            precipitate: Boolean(reaction.precipitate ?? visual.precipitate ?? effects.precipitate),
            precipitateColor: reaction.precipitateColor || reaction.precipitate_color || visual.precipitate_color || effects.precipitateColor || '#ffffff',
            gas: reaction.gas ?? visual.gas_effect ?? effects.gas ?? false,
            smoke: reaction.smoke ?? visual.smoke_effect ?? effects.smoke ?? false,
            fire: reaction.fire ?? visual.fire_effect ?? effects.fire ?? false,
            explosion: reaction.explosion ?? visual.explosion_effect ?? effects.explosion ?? false,
            heat: reaction.heat ?? visual.heat_effect ?? effects.heat ?? false,
            foam: reaction.foam ?? visual.foam ?? effects.foam ?? false,
            raw: reaction
        };
    }

    getContainerMouthPosition(container, fallback = null) {
        if (fallback) return fallback.clone();
        if (!container) return new THREE.Vector3();
        container.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(container);
        const center = new THREE.Vector3();
        box.getCenter(center);
        center.y = box.max.y + 0.035;
        return center;
    }

    apply(container, reaction, options = {}) {
        if (!container || !reaction) return null;
        const fx = this.normalizeReaction(reaction);
        if (!fx.hasReaction && !fx.precipitate && !fx.gas && !fx.smoke && !fx.fire) return null;

        const position = this.getContainerMouthPosition(container, options.position);
        const result = { position, effects: [] };

        // Kết tủa phải nằm trong dụng cụ, dùng local child layer.
        if (fx.precipitate) {
            result.precipitate = this.precipitateSystem.create(container, {
                color: fx.precipitateColor,
                amount: options.precipitateAmount ?? 620
            });
            result.effects.push('precipitate');
        }

        // Bọt khí nhẹ nằm gần mặt dung dịch, gas cloud bay lên.
        const gasIntensity = this.normalizeIntensity(fx.gas, 1);
        if (gasIntensity > 0) {
            result.gas = this.gasEmitter.bubbles(container, {
                position,
                amount: Math.floor(80 * Math.min(2, gasIntensity)),
                color: options.gasColor || '#ffffff'
            });
            // Giữ tương thích với reactionEffects.js sẵn có.
            spawnGasCloud?.(this.scene, position, { toxicity: gasIntensity });
            result.effects.push('gas');
        }

        if (fx.foam) { result.foam = this.gasEmitter.bubbles(container, { position, amount: 140, color: '#ffffff' }); }

        const smokeIntensity = this.normalizeIntensity(fx.smoke, 1);
        if (smokeIntensity > 0) {
            result.smoke = this.gasEmitter.smoke(container, {
                position,
                amount: Math.floor(70 * Math.min(2, smokeIntensity)),
                color: options.smokeColor || '#d8d8d8'
            });
            spawnSmoke?.(this.scene, position, { density: smokeIntensity });
            result.effects.push('smoke');
        }

        const fireIntensity = this.normalizeIntensity(fx.fire, 1);
        if (fireIntensity > 0) {
            spawnFireParticles?.(this.scene, position, { intensity: fireIntensity });
            result.effects.push('fire');
        }

        const explosionPower = this.normalizeIntensity(fx.explosion, 1);
        if (explosionPower > 0) {
            createShockwave?.(this.scene, position, { power: explosionPower });
            result.effects.push('explosion');
        }

        const heatStrength = this.normalizeIntensity(fx.heat, 1);
        if (heatStrength > 0) {
            heatDistortion?.(this.scene, position, { strength: heatStrength });
            result.effects.push('heat');
        }

        return result;
    }

    startPowderPour(position, color) {
        this.powderSystem.start(position, color);
    }

    emitPowder(position) {
        this.powderSystem.emit(position);
    }

    stopPowderPour() {
        this.powderSystem.stop();
    }

    createPowderDeposit(container, options = {}) {
        return this.powderSystem.createDeposit(container, options);
    }

    update(dt = null) {
        const delta = dt ?? Math.min(0.05, this.clock.getDelta());
        this.precipitateSystem.update(delta);
        this.gasEmitter.update(delta);
        this.powderSystem.update(delta);
    }
}

export function createDefaultReactionManager(scene, options = {}) {
    return new ReactionManager(scene, options);
}

export default ReactionManager;
