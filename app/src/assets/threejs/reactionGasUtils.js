const GAS_PRODUCT_PATTERNS = [
    /\bh2\b/,
    /\bco2\b/,
    /\bo2\b/,
    /\bcl2\b/,
    /\bnh3\b/,
    /\bso2\b/,
    /\bno2\b/,
    /\bn2\b/,
    /\bhcl\s*\(?g\)?\b/,
    /\bhydro\b/,
    /\bhidro\b/,
    /\bhydrogen\b/,
    /\bcarbon\s+dioxide\b/,
    /\bchlorine\b/,
    /\bclo\b/,
    /\boxi\b/,
    /\boxygen\b/,
    /\bamoniac\b/,
    /\bammonia\b/,
    /\bsulfur\s+dioxide\b/,
    /\bnitrogen\s+dioxide\b/
];

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/₂/g, '2')
        .replace(/₃/g, '3')
        .replace(/₄/g, '4')
        .replace(/₅/g, '5')
        .replace(/₆/g, '6')
        .replace(/₇/g, '7')
        .replace(/₈/g, '8')
        .replace(/₉/g, '9')
        .replace(/\s+/g, ' ')
        .trim();
}

function asArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function rawReaction(reaction) {
    return reaction?.raw || reaction?.reaction || {};
}

function reactionData(reaction) {
    const raw = rawReaction(reaction);
    return reaction?.reaction_data || raw?.reaction_data || {};
}

function productsOf(reaction) {
    const raw = rawReaction(reaction);
    const data = reactionData(reaction);
    return [
        ...asArray(reaction?.products),
        ...asArray(data?.products),
        ...asArray(raw?.products),
        ...asArray(raw?.reaction_data?.products)
    ].filter(Boolean);
}

function equationsOf(reaction) {
    const raw = rawReaction(reaction);
    const data = reactionData(reaction);
    return [
        reaction?.equation,
        data?.equation,
        raw?.equation,
        raw?.reaction_data?.equation
    ].filter(Boolean);
}

function effectListOf(reaction) {
    const raw = rawReaction(reaction);
    const direct = Array.isArray(reaction?.effects) ? reaction.effects : [];
    const rawEffects = Array.isArray(raw?.effects) ? raw.effects : [];
    return [...direct, ...rawEffects].filter(Boolean);
}

function effectMapOf(reaction) {
    const raw = rawReaction(reaction);
    return [
        Array.isArray(reaction?.effects) ? {} : (reaction?.effects || {}),
        Array.isArray(raw?.effects) ? {} : (raw?.effects || {}),
        reaction?.visual || {},
        raw?.visual || {}
    ];
}

function positiveFlag(value) {
    if (value === true) return true;
    if (value === false || value === null || value === undefined) return false;
    if (typeof value === 'number') return value > 0;
    if (typeof value === 'object') {
        const nested = value.intensity ?? value.power ?? value.strength ?? value.density ?? value.toxicity ?? value.value;
        if (nested !== undefined) return positiveFlag(nested);
        return true;
    }
    return false;
}

function hasEffectType(reaction, types) {
    const wanted = new Set(types);
    if (effectListOf(reaction).some(effect => wanted.has(effect?.type) && positiveFlag(effect))) {
        return true;
    }
    return effectMapOf(reaction).some(map => types.some(type => {
        const camel = type === 'vapor' ? 'vaporEffect' : `${type}Effect`;
        const snake = type === 'vapor' ? 'vapor_effect' : `${type}_effect`;
        return positiveFlag(map?.[type]) || positiveFlag(map?.[camel]) || positiveFlag(map?.[snake]);
    }));
}

function hasEffectListType(reaction, types) {
    const wanted = new Set(types);
    return effectListOf(reaction).some(effect => wanted.has(effect?.type) && positiveFlag(effect));
}

function hasMappedEffectType(reaction, types) {
    return effectMapOf(reaction).some(map => types.some(type => {
        const camel = type === 'vapor' ? 'vaporEffect' : `${type}Effect`;
        const snake = type === 'vapor' ? 'vapor_effect' : `${type}_effect`;
        return positiveFlag(map?.[type]) || positiveFlag(map?.[camel]) || positiveFlag(map?.[snake]);
    }));
}

function hasTopLevelGasFlag(reaction) {
    const raw = rawReaction(reaction);
    return positiveFlag(reaction?.gas)
        || positiveFlag(raw?.gas);
}

function hasTopLevelSmokeFlag(reaction) {
    const raw = rawReaction(reaction);
    return positiveFlag(reaction?.smoke)
        || positiveFlag(reaction?.vapor)
        || positiveFlag(raw?.smoke)
        || positiveFlag(raw?.vapor);
}

function hasHeatSignal(reaction) {
    const raw = rawReaction(reaction);
    return positiveFlag(reaction?.heat)
        || positiveFlag(raw?.heat)
        || hasEffectType(reaction, ['heat']);
}

function smokeTextOf(reaction) {
    const raw = rawReaction(reaction);
    const data = reactionData(reaction);
    return [
        reaction?.phenomenon,
        reaction?.reactionMessage,
        reaction?.reaction_message,
        reaction?.description,
        data?.phenomenon,
        data?.description,
        raw?.phenomenon,
        raw?.reactionMessage,
        raw?.reaction_message,
        raw?.description,
        raw?.reaction_data?.phenomenon,
        raw?.reaction_data?.description,
        ...productsOf(reaction),
        ...equationsOf(reaction)
    ].filter(Boolean).join(' ');
}

function hasSmokeOrVaporText(reaction) {
    const text = normalizeText(smokeTextOf(reaction));
    return /\b(smoke|fume|vapor|vapour|steam|mist)\b|khoi|hoi nuoc|hoi trang|khi trang|khoi trang|boc hoi|bay hoi|nh4cl_smoke|smoke_product/.test(text);
}

function hasRealSmokeSignal(reaction) {
    const explicitEffect = hasEffectListType(reaction, ['smoke', 'vapor']);
    const mappedEffect = hasMappedEffectType(reaction, ['smoke', 'vapor']);
    const topLevelFlag = hasTopLevelSmokeFlag(reaction);
    const smokeText = hasSmokeOrVaporText(reaction);

    if (explicitEffect || smokeText) return true;

    // Many analyzed rules mark hot reactions as vapor/smoke just because heat is present.
    // If there is no gas/smoke product and no explicit smoke effect, treat heat-only smoke
    // metadata as visual noise.
    if (hasHeatSignal(reaction)) return false;

    return topLevelFlag || mappedEffect;
}

function hasGasName(value) {
    const normalized = normalizeText(value);
    return GAS_PRODUCT_PATTERNS.some(pattern => pattern.test(normalized));
}

function equationHasGasProduct(equation) {
    const text = normalizeText(equation);
    if (!text) return false;
    if (/[↑↟]/.test(String(equation))) return true;
    const sides = text.split(/(?:->|=>|→|⇌|<->|=)/);
    const productSide = sides.length > 1 ? sides[sides.length - 1] : '';
    return !!productSide && hasGasName(productSide);
}

export function hasGasProduct(reaction) {
    const products = productsOf(reaction);
    const equations = equationsOf(reaction);
    const result = products.some(hasGasName) || equations.some(equationHasGasProduct);
    return result;
}

export function shouldEmitSmokeOrGas(reaction) {
    return hasTopLevelGasFlag(reaction)
        || hasEffectType(reaction, ['gas'])
        || hasRealSmokeSignal(reaction)
        || hasGasProduct(reaction);
}

export function hasExplicitSmoke(reaction) {
    return hasRealSmokeSignal(reaction);
}

export function hasExplicitGas(reaction) {
    const raw = rawReaction(reaction);
    return positiveFlag(reaction?.gas)
        || positiveFlag(raw?.gas)
        || hasEffectType(reaction, ['gas']);
}

export function reactionGasDebug(reaction) {
    const raw = rawReaction(reaction);
    return {
        reaction: reaction?.id || reaction?.rule_id || reaction?.reaction_id || raw?.id || raw?.rule_id || 'unknown',
        products: productsOf(reaction),
        equation: equationsOf(reaction).join(' | '),
        effects: reaction?.effects || raw?.effects || {},
        hasGasProduct: hasGasProduct(reaction),
        shouldEmitSmokeOrGas: shouldEmitSmokeOrGas(reaction)
    };
}
