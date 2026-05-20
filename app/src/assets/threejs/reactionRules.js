// Reaction client: ưu tiên backend deterministic engine theo ID hóa chất.
// Không còn dùng rule quá rộng kiểu "salt_solution + strong_base" vì dễ sai.

function toEffectIntensity(...values) {
    for (const value of values) {
        if (value === undefined || value === null) continue;
        if (typeof value === 'number') return Math.max(0, Math.min(2, value));
        if (value === true) return 1;
        if (value === false) continue;
        if (typeof value === 'object') {
            const nested = value.intensity ?? value.power ?? value.strength ?? value.density ?? value.toxicity ?? value.value;
            const n = toEffectIntensity(nested);
            if (n > 0) return n;
        }
    }
    return 0;
}

function inferVisibleEffects(data, text = '') {
    const haystack = [
        text,
        data?.mascot_speech,
        data?.mascotText,
        data?.equation,
        ...(data?.products || [])
    ].join(' ').toLowerCase();

    return {
        gas: /(h₂|h2|co₂|co2|khí|gas|bong bóng|bọt khí|↑)/i.test(haystack),
        smoke: /(khói|smoke|mù|hơi trắng|white fume|fume|nh₄cl|nh4cl)/i.test(haystack),
        fire: /(cháy|bốc cháy|lửa|fire|flame|ignit)/i.test(haystack),
        explosion: /(nổ|explosion|mạnh|violent)/i.test(haystack),
        heat: /(tỏa nhiệt|nóng|heat|exothermic)/i.test(haystack)
    };
}

function normalizeApiReaction(data) {
    if (!data || !data.has_reaction) {
        return {
            has_reaction: false,
            reason: data?.reason || 'no_reaction',
            mascotText: data?.mascot_speech || 'Không có dấu hiệu phản ứng hóa học rõ ràng.'
        };
    }

    const visual = data.visual || {};
    const effects = data.effects || {};
    const inferred = inferVisibleEffects(data);

    const resultColor =
        data.color ||
        visual.result_color ||
        visual.color ||
        '#ffffff';

    const gas = toEffectIntensity(data.gas, visual.gas_effect, effects.gas, inferred.gas);
    const smoke = toEffectIntensity(data.smoke, visual.smoke_effect, effects.smoke, inferred.smoke);
    const fire = toEffectIntensity(data.fire, visual.fire_effect, effects.fire, inferred.fire);
    const explosion = toEffectIntensity(data.explosion, visual.explosion_effect, effects.explosion, inferred.explosion);
    const heat = toEffectIntensity(data.heat, visual.heat_effect, effects.heat, inferred.heat);

    return {
        has_reaction: true,
        color: resultColor,
        gas,
        smoke,
        fire,
        explosion,
        heat,
        precipitate: Boolean(data.precipitate ?? visual.precipitate ?? effects.precipitate),
        precipitateColor: data.precipitateColor || data.precipitate_color || visual.precipitate_color || effects.precipitateColor || '#ffffff',
        result_chemical_type: data.reaction_data?.result_chemical_type || data.result_chemical_type || 'generic_solution',
        equation: data.reaction_data?.equation || data.equation || '',
        products: data.reaction_data?.products || data.products || [],
        mascotText: data.mascot_speech || data.mascotText || 'Phản ứng hóa học đã xảy ra.',
        raw: data
    };
}

// Fallback nhỏ khi backend chưa chạy. Chỉ giữ các phản ứng chắc chắn, không đoán rộng.
const VERIFIED_FALLBACK_RULES = [
    {
        names: ['Đồng(II) Sunfat', 'Natri Hydroxit'],
        result: {
            has_reaction: true,
            precipitate: true,
            precipitateColor: '#4fc3f7',
            color: '#9bd6ff',
            equation: 'CuSO₄ + 2NaOH → Cu(OH)₂↓ + Na₂SO₄',
            mascotText: 'Đã tạo kết tủa Đồng(II) hiđroxit Cu(OH)₂ màu xanh lam.'
        }
    },
    {
        names: ['Bari Clorua', 'Axit Sunfuric'],
        result: {
            has_reaction: true,
            precipitate: true,
            precipitateColor: '#ffffff',
            color: '#f8f8ff',
            equation: 'BaCl₂ + H₂SO₄ → BaSO₄↓ + 2HCl',
            mascotText: 'Xuất hiện kết tủa Bari sunfat BaSO₄ màu trắng.'
        }
    },
    {
        names: ['Bạc Nitrat', 'Axit Clohidric'],
        result: {
            has_reaction: true,
            precipitate: true,
            precipitateColor: '#f5f5f5',
            color: '#ffffff',
            equation: 'AgNO₃ + HCl → AgCl↓ + HNO₃',
            mascotText: 'Ion Ag⁺ gặp ion Cl⁻ tạo kết tủa AgCl màu trắng.'
        }
    },
    {
        names: ['Natri', 'Nước'],
        result: {
            has_reaction: true,
            gas: true,
            fire: true,
            heat: true,
            explosion: true,
            color: '#fff7cc',
            equation: '2Na + 2H₂O → 2NaOH + H₂↑',
            mascotText: 'Natri phản ứng mạnh với nước, tạo NaOH và khí H₂; phản ứng tỏa nhiệt.'
        }
    }
];

function fallbackByName(sourceName, targetName) {
    const a = String(sourceName || '').toLowerCase().trim();
    const b = String(targetName || '').toLowerCase().trim();

    for (const rule of VERIFIED_FALLBACK_RULES) {
        const [x, y] = rule.names.map(v => v.toLowerCase().trim());
        if ((a === x && b === y) || (a === y && b === x)) {
            return { ...rule.result };
        }
    }

    return { has_reaction: false, reason: 'no_verified_fallback_rule' };
}

export async function detectReaction(source, target) {
    const sourceId = source?.userData?.id_chemical || source?.userData?.current_chemical_id;
    const targetId = target?.userData?.current_chemical_id || target?.userData?.id_chemical;

    if (!sourceId || !targetId || sourceId === targetId) {
        return { has_reaction: false, reason: 'missing_or_same_chemical_id' };
    }

    try {
        const url = `/api/reactions/check?source_id=${encodeURIComponent(sourceId)}&target_id=${encodeURIComponent(targetId)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return normalizeApiReaction(data);
    } catch (error) {
        console.warn('Backend reaction API unavailable, using verified fallback:', error);
        return fallbackByName(
            source?.userData?.name_vi || source?.userData?.chemicalName,
            target?.userData?.chemicalName || target?.userData?.name_vi
        );
    }
}
