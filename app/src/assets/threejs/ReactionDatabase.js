// Stateful deterministic reaction engine for the Three.js virtual lab.
// Rules are data-first so new reactions can be added without touching matcher logic.

const norm = (value) => String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/₂/g, '2')
    .replace(/₃/g, '3')
    .replace(/₄/g, '4')
    .replace(/₅/g, '5')
    .replace(/₆/g, '6')
    .replace(/₈/g, '8')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const CANONICAL = new Map([
    ['hcl', 'Axit Clohidric'],
    ['axit clohidric', 'Axit Clohidric'],
    ['hydrochloric acid', 'Axit Clohidric'],
    ['h2so4', 'Axit Sunfuric'],
    ['axit sunfuric', 'Axit Sunfuric'],
    ['sulfuric acid', 'Axit Sunfuric'],
    ['hno3', 'Axit Nitric'],
    ['axit nitric', 'Axit Nitric'],
    ['ch3cooh', 'Axit Axetic'],
    ['axit axetic', 'Axit Axetic'],
    ['acetic acid', 'Axit Axetic'],
    ['naoh', 'Natri Hydroxit'],
    ['natri hydroxit', 'Natri Hydroxit'],
    ['nh3', 'Amoniac'],
    ['amoniac', 'Amoniac'],
    ['agno3', 'Bạc Nitrat'],
    ['bac nitrat', 'Bạc Nitrat'],
    ['cuso4', 'Đồng(II) Sunfat'],
    ['dong ii sunfat', 'Đồng(II) Sunfat'],
    ['cu so4', 'Đồng(II) Sunfat'],
    ['bacl2', 'Bari Clorua'],
    ['bari clorua', 'Bari Clorua'],
    ['kmno4', 'Kali Pemanganat'],
    ['kali pemanganat', 'Kali Pemanganat'],
    ['mno2', 'Mangan Đioxit'],
    ['mangan dioxit', 'Mangan Đioxit'],
    ['glucozo', 'Glucozơ'],
    ['glucose', 'Glucozơ'],
    ['i2', 'Iốt'],
    ['iot', 'Iốt'],
    ['c2h5oh', 'Ancol Etylic'],
    ['ancol etylic', 'Ancol Etylic'],
    ['ethanol', 'Ancol Etylic'],
    ['phenolphthalein', 'Phenolphthalein'],
    ['natri', 'Natri'],
    ['na', 'Natri'],
    ['nuoc', 'Nước'],
    ['h2o', 'Nước'],
    ['cu oh 2', 'Đồng Hydroxit'],
    ['cuoh2', 'Đồng Hydroxit'],
    ['dong hydroxit', 'Đồng Hydroxit'],
    ['agoh', 'AgOH'],
    ['bac hydroxit', 'AgOH'],
    ['ag2o', 'Ag2O'],
    ['bac oxit', 'Ag2O'],
    ['ag nh3 2 oh', '[Ag(NH3)2]OH'],
    ['thuoc thu tollens', '[Ag(NH3)2]OH'],
    ['tollens', '[Ag(NH3)2]OH'],
    ['cu nh3 4 oh 2', '[Cu(NH3)4](OH)2'],
    ['phuc dong amoniac', '[Cu(NH3)4](OH)2'],
    ['phenolphthalein dang bazo', 'Phenolphthalein dạng bazơ']
]);

export function normalizeChemicalName(name) {
    const n = norm(name);
    return CANONICAL.get(n) || String(name || '').trim();
}

function canonicalKey(name) {
    return norm(normalizeChemicalName(name));
}

function addAmount(map, name, amount = 1) {
    if (!name) return;
    const canonical = normalizeChemicalName(name);
    const key = canonicalKey(canonical);
    if (!key) return;
    const current = map.get(key) || { name: canonical, amount: 0 };
    current.amount += Number(amount) || 1;
    map.set(key, current);
}

function collectObjectSpecies(obj, weight = 1) {
    const species = new Map();
    const u = obj?.userData || {};
    [
        u.current_chemical_name,
        u.chemicalName,
        u.name_vi,
        u.formula,
        u.current_chemical_type,
        u.chemicalType,
        u.chemical_type,
        u.current_chemical_id,
        u.id_chemical,
        u.complexIon,
        u.precipitateSpecies,
        u.indicator === 'pink' ? 'Phenolphthalein dạng bazơ' : null,
        ...(u.contents || []),
        ...(u.products || []),
        ...(u.reactionProducts || []),
        ...(u.existingSpecies || [])
    ].filter(Boolean).forEach(name => addAmount(species, name, weight));

    const composition = u.composition || {};
    Object.entries(composition).forEach(([name, amount]) => addAmount(species, name, amount));

    if (u.hasPrecipitate && u.precipitateSpecies) addAmount(species, u.precipitateSpecies, 1);
    if (u.hasSilverMirror) addAmount(species, 'Bạc kim loại', 1);
    return species;
}

function mergeSpecies(...maps) {
    const merged = new Map();
    maps.forEach(map => {
        for (const item of map.values()) addAmount(merged, item.name, item.amount);
    });
    return merged;
}

function has(ctx, name, minimum = 0.0001) {
    return (ctx.amount(name) >= minimum);
}

function hasAny(ctx, names) {
    return names.some(name => has(ctx, name));
}

function hasAll(ctx, names) {
    return names.every(name => has(ctx, name));
}

function dominantEnvironment(ctx) {
    const acid = ['Axit Clohidric', 'Axit Sunfuric', 'Axit Nitric', 'Axit Axetic']
        .reduce((sum, name) => sum + ctx.amount(name), 0);
    const base = ['Natri Hydroxit', 'Amoniac']
        .reduce((sum, name) => sum + ctx.amount(name), 0);
    if (acid > base + 0.1) return 'acidic';
    if (base > acid + 0.1) return 'basic';
    return 'neutral';
}

function makeContext(source, target) {
    const sourceSpecies = collectObjectSpecies(source, 1);
    const targetSpecies = collectObjectSpecies(target, 1);
    const species = mergeSpecies(targetSpecies, sourceSpecies);

    const ctx = {
        source,
        target,
        species,
        sourceSpecies,
        targetSpecies,
        temperature: Math.max(
            Number(source?.userData?.temperature ?? source?.userData?.currentTemperature ?? 25),
            Number(target?.userData?.temperature ?? target?.userData?.currentTemperature ?? 25)
        ),
        amount(name) {
            return species.get(canonicalKey(name))?.amount || 0;
        },
        sourceAmount(name) {
            return sourceSpecies.get(canonicalKey(name))?.amount || 0;
        },
        targetAmount(name) {
            return targetSpecies.get(canonicalKey(name))?.amount || 0;
        },
        environment: 'neutral',
        distance: Infinity
    };
    ctx.environment = dominantEnvironment(ctx);

    if (source?.position?.distanceTo && target?.position) {
        ctx.distance = source.position.distanceTo(target.position);
    }
    return ctx;
}

function result(base) {
    return {
        has_reaction: true,
        color: '#ffffff',
        result_chemical_type: 'generic_solution',
        products: [],
        effects: [],
        consumes: {},
        producesState: {},
        ...base
    };
}

function effect(type, options = {}) {
    return { type, ...options };
}

export const LOCAL_REACTION_RULES = [
    {
        id: 'silver_mirror_from_tollens_glucose_heat',
        name: 'Phản ứng tráng bạc',
        aliases: ['phản ứng tráng bạc', 'tráng bạc', 'tráng gương', 'gương bạc', 'Tollens', 'thuốc thử Tollens', 'bạc amoniac', 'silver mirror'],
        keywords: ['AgNO3', 'NH3', 'aldehyde', 'andehit', 'glucose', 'glucozơ', '[Ag(NH3)2]OH', 'bạc amoniac'],
        phenomenon: 'Xuất hiện lớp bạc sáng bám trên thành ống nghiệm',
        priority: 140,
        reactants: ['Glucozơ'],
        requiredExistingSpecies: ['[Ag(NH3)2]OH'],
        conditions: { minTemperature: 45 },
        products: ['Bạc kim loại', 'Amoni Gluconat'],
        effects: [effect('mirrorSilver'), effect('heat', { intensity: 0.45 })],
        producesState: { hasSilverMirror: true, complexIon: null },
        result: result({
            color: '#f6f6f6',
            result_chemical_id: 'silver_mirror_product',
            result_chemical_type: 'metal_coating_solution',
            equation: 'C6H12O6 + 2[Ag(NH3)2]OH -> 2Ag + oxidation products',
            mascotText: 'Glucozơ khử thuốc thử Tollens khi đun nóng, tạo lớp bạc kim loại bám trong thành ống nghiệm.'
        })
    },
    {
        id: 'agoh_or_ag2o_dissolves_in_excess_nh3',
        priority: 130,
        reactants: ['Amoniac'],
        requiredExistingSpecies: ['AgOH|Ag2O'],
        conditions: { excess: { reagent: 'Amoniac', over: ['AgOH', 'Ag2O'], ratio: 1.2 } },
        products: ['[Ag(NH3)2]OH'],
        effects: [effect('dissolvePrecipitate'), effect('decolorize')],
        producesState: { complexIon: '[Ag(NH3)2]OH', precipitateSpecies: null },
        result: result({
            color: '#f8fbff',
            result_chemical_id: 'tollens_reagent',
            result_chemical_type: 'complex_solution',
            equation: 'AgOH + 2NH3 -> [Ag(NH3)2]OH',
            mascotText: 'Amoniac dư hòa tan kết tủa bạc, tạo dung dịch phức bạc trong suốt.'
        })
    },
    {
        id: 'cuoh2_dissolves_in_excess_nh3',
        priority: 125,
        reactants: ['Amoniac'],
        requiredExistingSpecies: ['Đồng Hydroxit'],
        conditions: { excess: { reagent: 'Amoniac', over: ['Đồng Hydroxit'], ratio: 1.2 } },
        products: ['[Cu(NH3)4](OH)2'],
        effects: [effect('dissolvePrecipitate')],
        producesState: { complexIon: '[Cu(NH3)4](OH)2', precipitateSpecies: null },
        result: result({
            color: '#00008B',
            transparency: 0.88,
            result_chemical_id: 'cu_tetrammine_complex_solution',
            result_chemical_type: 'complex_solution',
            equation: 'Cu(OH)2 + 4NH3 -> [Cu(NH3)4](OH)2',
            mascotText: 'Kết tủa Cu(OH)2 tan trong NH3 dư, tạo dung dịch xanh thẫm trong suốt.'
        })
    },
    {
        id: 'phenolphthalein_acid_excess_clear',
        priority: 120,
        requiredExistingSpecies: ['Phenolphthalein dạng bazơ'],
        reactants: ['Axit Clohidric|Axit Sunfuric|Axit Nitric|Axit Axetic'],
        conditions: { environment: 'acidic' },
        products: ['Phenolphthalein'],
        effects: [effect('decolorize'), effect('heat', { intensity: 0.25 })],
        producesState: { indicator: 'clear' },
        result: result({
            color: '#ffffff',
            result_chemical_type: 'indicator_solution',
            equation: 'H+ neutralizes OH- -> phenolphthalein becomes colorless',
            mascotText: 'Axit dư trung hòa bazơ, màu hồng phenolphthalein mất hoàn toàn.'
        })
    },
    {
        id: 'cu_so4_nh3_limited',
        priority: 90,
        reactants: ['Đồng(II) Sunfat', 'Amoniac'],
        conditions: { notExisting: ['[Cu(NH3)4](OH)2'] },
        products: ['Đồng Hydroxit', 'Amoni Sunfat'],
        effects: [effect('precipitate', { color: '#87CEFA', amount: 760 })],
        producesState: { precipitateSpecies: 'Đồng Hydroxit' },
        result: result({
            color: '#9bd6ff',
            precipitate: true,
            precipitateColor: '#87CEFA',
            result_chemical_id: 'cuoh2_precipitate_suspension',
            result_chemical_type: 'precipitate_suspension',
            equation: 'CuSO4 + 2NH3 + 2H2O -> Cu(OH)2 + (NH4)2SO4',
            mascotText: 'Xuất hiện kết tủa keo xanh lam nhạt Cu(OH)2.'
        })
    },
    {
        id: 'ag_no3_nh3_ag2o',
        name: 'Phản ứng Bạc Nitrat và Amoniac',
        aliases: ['AgNO3 NH3', 'bạc nitrat amoniac', 'bạc nitrat ammonia', 'bạc oxit nâu đen'],
        keywords: ['AgNO3', 'NH3', 'Ag2O', 'NH4NO3', 'kết tủa nâu đen'],
        phenomenon: 'Xuất hiện kết tủa nâu đen Ag2O',
        priority: 90,
        reactants: ['Bạc Nitrat', 'Amoniac'],
        conditions: { notExisting: ['[Ag(NH3)2]OH'] },
        products: ['Ag2O', 'Amoni Nitrat'],
        effects: [effect('precipitate', { color: '#2b2118', amount: 720 })],
        producesState: { precipitateSpecies: 'Ag2O' },
        result: result({
            color: '#8a7564',
            precipitate: true,
            precipitateColor: '#2b2118',
            result_chemical_id: 'ag2o_precipitate_suspension',
            result_chemical_type: 'precipitate_suspension',
            equation: '2AgNO3 + 2NH3 + H2O -> Ag2O + 2NH4NO3',
            mascotText: 'Tạo kết tủa nâu đen Ag2O.'
        })
    },
    {
        id: 'ag_no3_naoh_ag2o',
        priority: 90,
        reactants: ['Bạc Nitrat', 'Natri Hydroxit'],
        products: ['Ag2O', 'Natri Nitrat'],
        effects: [effect('precipitate', { color: '#2b2b2b', amount: 720 })],
        producesState: { precipitateSpecies: 'Ag2O' },
        result: result({
            color: '#aaaaaa',
            precipitate: true,
            precipitateColor: '#2b2b2b',
            result_chemical_id: 'ag2o_precipitate_suspension',
            result_chemical_type: 'precipitate_suspension',
            equation: '2AgNO3 + 2NaOH -> Ag2O + 2NaNO3 + H2O',
            mascotText: 'Tạo kết tủa xám đen Ag2O.'
        })
    },
    {
        id: 'sodium_acid_first',
        priority: 110,
        reactants: ['Natri', 'Axit Clohidric|Axit Sunfuric|Axit Nitric|Axit Axetic'],
        conditions: { environment: 'acidic' },
        products: ['Muối Natri', 'Hydro'],
        effects: [effect('gas', { intensity: 1.7, color: '#ffffff' }), effect('foam'), effect('heat', { intensity: 1.35 }), effect('fire', { intensity: 0.35 })],
        producesState: { generatedBase: false },
        result: result({
            color: '#ffffff',
            gas: 1.7,
            foam: true,
            heat: 1.35,
            fire: 0.35,
            gasColor: '#ffffff',
            result_chemical_id: 'sodium_salt_solution',
            result_chemical_type: 'salt_solution',
            equation: '2Na + 2H+ -> 2Na+ + H2',
            mascotText: 'Natri ưu tiên phản ứng rất mạnh với axit, sủi H2 và tỏa nhiệt mạnh.'
        })
    },
    {
        id: 'sodium_water_after_acid_depleted',
        priority: 55,
        reactants: ['Natri', 'Nước'],
        conditions: { notEnvironment: 'acidic' },
        products: ['Natri Hydroxit', 'Hydro'],
        effects: [effect('gas', { intensity: 1.2 }), effect('foam'), effect('heat', { intensity: 1.0 })],
        producesState: { generatedBase: true },
        result: result({
            color: '#f6ffff',
            gas: 1.2,
            foam: true,
            heat: 1.0,
            result_chemical_id: 'naoh_solution',
            result_chemical_type: 'base_solution',
            equation: '2Na + 2H2O -> 2NaOH + H2',
            mascotText: 'Khi axit không còn dư, Natri tiếp tục phản ứng với nước tạo NaOH và H2.'
        })
    },
    {
        id: 'ba_cl2_h2so4',
        name: 'Phản ứng Bari Clorua và Axit Sunfuric',
        aliases: ['bari clorua axit sunfuric', 'BaCl2 H2SO4', 'bari sunfat', 'BaSO4'],
        keywords: ['BaCl2', 'H2SO4', 'BaSO4', 'kết tủa trắng'],
        phenomenon: 'Xuất hiện kết tủa trắng đặc Bari Sunfat',
        priority: 80,
        reactants: ['Bari Clorua', 'Axit Sunfuric'],
        products: ['Bari Sunfat', 'Axit Clohidric'],
        effects: [effect('precipitate', { color: '#ffffff', amount: 900 })],
        producesState: { precipitateSpecies: 'Bari Sunfat' },
        result: result({ color: '#ffffff', precipitate: true, precipitateColor: '#ffffff', equation: 'BaCl2 + H2SO4 -> BaSO4 + 2HCl', mascotText: 'Xuất hiện kết tủa trắng đặc BaSO4.' })
    },
    {
        id: 'ba_cl2_cuso4',
        priority: 80,
        reactants: ['Bari Clorua', 'Đồng(II) Sunfat'],
        products: ['Bari Sunfat', 'Đồng(II) Clorua'],
        effects: [effect('precipitate', { color: '#ffffff', amount: 760 })],
        producesState: { precipitateSpecies: 'Bari Sunfat' },
        result: result({ color: '#d9f4ff', precipitate: true, precipitateColor: '#ffffff', equation: 'BaCl2 + CuSO4 -> BaSO4 + CuCl2', mascotText: 'Tạo kết tủa trắng BaSO4.' })
    },
    {
        id: 'ag_no3_hcl',
        priority: 80,
        reactants: ['Bạc Nitrat', 'Axit Clohidric'],
        products: ['Bạc Clorua', 'Axit Nitric'],
        effects: [effect('precipitate', { color: '#ffffff', amount: 780, clumpy: true })],
        producesState: { precipitateSpecies: 'Bạc Clorua' },
        result: result({ color: '#ffffff', precipitate: true, precipitateColor: '#ffffff', equation: 'AgNO3 + HCl -> AgCl + HNO3', mascotText: 'Tạo kết tủa trắng vón cục AgCl.' })
    },
    {
        id: 'ag_no3_bacl2',
        priority: 80,
        reactants: ['Bạc Nitrat', 'Bari Clorua'],
        products: ['Bạc Clorua', 'Bari Nitrat'],
        effects: [effect('precipitate', { color: '#ffffff', amount: 820, clumpy: true })],
        producesState: { precipitateSpecies: 'Bạc Clorua' },
        result: result({ color: '#ffffff', precipitate: true, precipitateColor: '#ffffff', equation: '2AgNO3 + BaCl2 -> 2AgCl + Ba(NO3)2', mascotText: 'Tạo kết tủa trắng vón cục AgCl.' })
    },
    {
        id: 'cu_so4_naoh',
        name: 'Phản ứng Đồng(II) Sunfat và Natri Hydroxit',
        aliases: ['đồng sunfat natri hidroxit', 'đồng sunfat natri hydroxit', 'Đồng(II) Sunfat Natri Hydroxit', 'CuSO4 NaOH', 'đồng hidroxit', 'đồng hydroxit'],
        keywords: ['CuSO4', 'NaOH', 'Cu(OH)2', 'kết tủa xanh'],
        phenomenon: 'Xuất hiện kết tủa xanh lam keo Đồng Hydroxit',
        priority: 80,
        reactants: ['Đồng(II) Sunfat', 'Natri Hydroxit'],
        products: ['Đồng Hydroxit', 'Natri Sunfat'],
        effects: [effect('precipitate', { color: '#4fc3f7', amount: 760 })],
        producesState: { precipitateSpecies: 'Đồng Hydroxit' },
        result: result({ color: '#9bd6ff', precipitate: true, precipitateColor: '#4fc3f7', equation: 'CuSO4 + 2NaOH -> Cu(OH)2 + Na2SO4', mascotText: 'Xuất hiện kết tủa xanh lam keo Cu(OH)2.' })
    },
    {
        id: 'kmno4_conc_hcl_chlorine',
        priority: 85,
        reactants: ['Kali Pemanganat', 'Axit Clohidric'],
        conditions: { environment: 'acidic' },
        products: ['Clo', 'Mangan(II) Clorua'],
        effects: [effect('decolorize'), effect('gas', { intensity: 1.4, color: '#d8ff9d' }), effect('smoke', { intensity: 0.35, color: '#d8ff9d' })],
        result: result({
            color: '#eef7d4',
            gas: 1.4,
            smoke: 0.35,
            gasColor: '#d8ff9d',
            equation: '2KMnO4 + 16HCl -> 2KCl + 2MnCl2 + 5Cl2 + 8H2O',
            mascotText: 'Màu tím KMnO4 mất dần, sinh khí Clo vàng lục nhạt.'
        })
    },
    {
        id: 'mno2_hcl_heat_chlorine',
        priority: 115,
        reactants: ['Mangan Đioxit', 'Axit Clohidric'],
        conditions: { minTemperature: 45 },
        products: ['Clo', 'Mangan(II) Clorua'],
        effects: [effect('dissolveSolid'), effect('gas', { intensity: 1.1, color: '#d8ff9d' }), effect('smoke', { intensity: 0.35, color: '#d8ff9d' })],
        result: result({
            color: '#e8f5d0',
            gas: 1.1,
            smoke: 0.35,
            gasColor: '#d8ff9d',
            equation: 'MnO2 + 4HCl -> MnCl2 + Cl2 + 2H2O',
            mascotText: 'Khi đun nóng, bột MnO2 đen tan dần và sinh khí Clo vàng lục.'
        })
    },
    {
        id: 'glucose_iodine_naoh_decolorize',
        priority: 95,
        reactants: ['Glucozơ', 'Iốt', 'Natri Hydroxit'],
        conditions: { environment: 'basic' },
        products: ['Iodua'],
        effects: [effect('decolorize')],
        result: result({
            color: '#ffffff',
            equation: 'I2 is reduced to I- by glucose in alkaline solution',
            mascotText: 'Glucozơ khử I2 trong môi trường kiềm, dung dịch iốt mất màu hoàn toàn.'
        })
    },
    {
        id: 'hcl_nh3_near_mouth_smoke',
        priority: 100,
        reactants: ['Axit Clohidric', 'Amoniac'],
        conditions: { proximity: 0.75 },
        products: ['Amoni Clorua'],
        effects: [effect('smoke', { intensity: 1.7, color: '#ffffff' })],
        result: result({
            color: '#ffffff',
            smoke: 1.7,
            smokeColor: '#ffffff',
            result_chemical_id: 'nh4cl_smoke',
            result_chemical_type: 'smoke_product',
            equation: 'HCl(g) + NH3(g) -> NH4Cl(s)',
            mascotText: 'Hơi HCl và NH3 gặp nhau gần miệng dụng cụ, tạo khói trắng NH4Cl.'
        })
    },
    ...[
        ['hcl_naoh_neutralization', ['Axit Clohidric', 'Natri Hydroxit'], 'Natri Clorua', 'HCl + NaOH -> NaCl + H2O', 0.7],
        ['h2so4_naoh_neutralization', ['Axit Sunfuric', 'Natri Hydroxit'], 'Natri Sunfat', 'H2SO4 + 2NaOH -> Na2SO4 + 2H2O', 0.9],
        ['hno3_naoh_neutralization', ['Axit Nitric', 'Natri Hydroxit'], 'Natri Nitrat', 'HNO3 + NaOH -> NaNO3 + H2O', 0.7],
        ['ch3cooh_naoh_neutralization', ['Axit Axetic', 'Natri Hydroxit'], 'Natri Axetat', 'CH3COOH + NaOH -> CH3COONa + H2O', 0.45],
        ['ch3cooh_nh3_neutralization', ['Axit Axetic', 'Amoniac'], 'Amoni Axetat', 'CH3COOH + NH3 -> CH3COONH4', 0.25]
    ].map(([id, reactants, salt, equation, heat]) => ({
        id,
        priority: 65,
        reactants,
        products: [salt, 'Nước'],
        effects: [effect('heat', { intensity: heat })],
        result: result({
            color: '#ffffff',
            heat,
            result_chemical_id: `${id}_solution`,
            result_chemical_type: 'salt_solution',
            equation,
            mascotText: 'Phản ứng trung hòa tạo muối tan, dung dịch trong suốt và tỏa nhiệt.'
        })
    })),
    {
        id: 'ethyl_acetate_esterification',
        priority: 105,
        reactants: ['Axit Axetic', 'Ancol Etylic'],
        requiredExistingSpecies: ['Axit Sunfuric'],
        conditions: { minTemperature: 80, catalyst: 'Axit Sunfuric' },
        products: ['Etyl Axetat', 'Nước'],
        effects: [effect('heat', { intensity: 0.3 }), effect('phaseSeparation', { upperColor: '#fff4c2', lowerColor: '#f8f8ff' })],
        producesState: { phaseSeparated: true, upperLayer: 'Etyl Axetat' },
        result: result({
            color: '#fff4c2',
            heat: 0.3,
            twoLayerLiquid: true,
            result_chemical_id: 'ethyl_acetate_two_layer',
            result_chemical_type: 'ester_two_layer_solution',
            equation: 'CH3COOH + C2H5OH <-> CH3COOC2H5 + H2O',
            mascotText: 'Có H2SO4 đặc xúc tác và nhiệt độ trên 80°C, tạo etyl axetat tách thành lớp nhẹ nổi phía trên.'
        })
    },
    {
        id: 'phenolphthalein_base_pink',
        priority: 75,
        reactants: ['Phenolphthalein', 'Natri Hydroxit|Amoniac'],
        conditions: { environment: 'basic' },
        products: ['Phenolphthalein dạng bazơ'],
        effects: [effect('colorChange', { color: '#FF1493' })],
        producesState: { indicator: 'pink' },
        result: result({
            color: '#FF1493',
            result_chemical_type: 'indicator_solution',
            equation: 'Phenolphthalein + base -> pink form',
            mascotText: 'Phenolphthalein chuyển hồng cánh sen trong môi trường bazơ.'
        })
    }
];

const REACTION_FUZZY_THRESHOLD = 2.2;
const SEARCH_STOPWORDS = new Set([
    'phan', 'ung', 'thi', 'nghiem', 'hoa', 'hoc', 'toi', 'muon', 'can',
    'hay', 'giup', 'minh', 'khong', 'ton', 'tai', 've', 'voi',
    'va', 'cua', 'tu', 'tao', 'ra', 'nhu', 'the', 'nao', 'dung', 'dich'
]);

function compactText(value) {
    return norm(value).replace(/[^a-z0-9]+/g, '');
}

function searchTokens(value) {
    return new Set((norm(value).match(/[a-z0-9]{2,}/g) || [])
        .filter(token => !SEARCH_STOPWORDS.has(token)));
}

function hasPhraseOrFormula(queryNorm, queryCompact, value) {
    const valueNorm = norm(value);
    if (!valueNorm) return false;
    const valueCompact = compactText(valueNorm);
    const tokens = searchTokens(valueNorm);
    const isFormula = /^[a-z]{1,3}\d[a-z0-9]*$/.test(valueNorm);
    const isDistinct = tokens.size >= 2 || valueNorm.length >= 7 || isFormula;
    if (!isDistinct) return false;
    if (isFormula) {
        return new RegExp(`(^|[^a-z0-9])${valueNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(queryNorm);
    }
    return queryNorm.includes(valueNorm) || (valueCompact && queryCompact.includes(valueCompact));
}

function displayNameFromRule(rule) {
    if (rule.name) return rule.name;
    const reactants = (rule.reactants || []).map(spec => alternatives(spec)[0]).filter(Boolean);
    const products = (rule.products || rule.result?.products || []).map(spec => alternatives(spec)[0]).filter(Boolean);
    if (reactants.length && products.length) return `Phản ứng ${reactants.join(' + ')} tạo ${products.join(' + ')}`;
    if (reactants.length) return `Phản ứng ${reactants.join(' + ')}`;
    return rule.id || 'Phản ứng trong ReactionDatabase.js';
}

function phenomenonFromRule(rule) {
    return rule.phenomenon || rule.result?.mascotText || '';
}

function normalizedReaction(rule) {
    return {
        ...rule,
        name: displayNameFromRule(rule),
        aliases: Array.isArray(rule.aliases) ? rule.aliases : [],
        keywords: Array.isArray(rule.keywords) ? rule.keywords : [],
        reactants: Array.isArray(rule.reactants) ? rule.reactants : [],
        products: Array.isArray(rule.products) ? rule.products : (rule.result?.products || []),
        phenomenon: phenomenonFromRule(rule)
    };
}

export const REACTION_SEARCH_RULES = LOCAL_REACTION_RULES.map(normalizedReaction);

export function hasExactKeywordMatch(query, reaction) {
    const normalizedQuery = norm(query);
    const compactQuery = compactText(query);
    const rule = normalizedReaction(reaction);
    const values = [
        rule.name,
        rule.phenomenon,
        ...(rule.aliases || []),
        ...(rule.keywords || [])
    ];

    if (values.some(value => hasPhraseOrFormula(normalizedQuery, compactQuery, value))) return true;

    const matchedChemicals = [];
    for (const spec of [...(rule.reactants || []), ...(rule.requiredExistingSpecies || []), ...(rule.products || [])]) {
        for (const option of alternatives(spec)) {
            const canonical = normalizeChemicalName(option);
            const candidateValues = [option, canonical];
            for (const [alias, target] of CANONICAL.entries()) {
                if (norm(target) === norm(canonical)) candidateValues.push(alias);
            }
            if (candidateValues.some(value => hasPhraseOrFormula(normalizedQuery, compactQuery, value))) {
                matchedChemicals.push(canonical);
                break;
            }
        }
    }
    return new Set(matchedChemicals.map(norm)).size >= 2;
}

export function scoreReaction(query, reaction) {
    const normalizedQuery = norm(query);
    const compactQuery = compactText(query);
    const queryTokens = searchTokens(query);
    const rule = normalizedReaction(reaction);
    const searchText = norm([
        rule.id?.replace(/_/g, ' '),
        rule.name,
        ...(rule.aliases || []),
        ...(rule.keywords || []),
        ...(rule.reactants || []),
        ...(rule.requiredExistingSpecies || []),
        ...(rule.products || []),
        rule.phenomenon,
        rule.result?.mascotText,
        rule.result?.equation,
        ...(rule.effects || []).map(fx => fx.type)
    ].filter(Boolean).join(' '));
    const compactSearch = compactText(searchText);

    let score = 0;
    for (const token of queryTokens) {
        if (token.length <= 2) {
            if (new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(searchText)) score += 1;
        } else if (searchText.includes(token) || compactSearch.includes(compactText(token))) {
            score += 1;
        }
    }

    for (const value of [rule.name, ...(rule.aliases || [])]) {
        if (hasPhraseOrFormula(normalizedQuery, compactQuery, value)) score += 8;
    }
    for (const value of (rule.keywords || [])) {
        if (hasPhraseOrFormula(normalizedQuery, compactQuery, value)) score += 4;
    }
    for (const spec of rule.reactants || []) {
        if (alternatives(spec).some(option => hasPhraseOrFormula(normalizedQuery, compactQuery, option))) score += 3;
    }
    for (const spec of rule.products || []) {
        if (alternatives(spec).some(option => hasPhraseOrFormula(normalizedQuery, compactQuery, option))) score += 1.5;
    }
    if (rule.phenomenon && hasPhraseOrFormula(normalizedQuery, compactQuery, rule.phenomenon)) score += 2;

    return score + Math.min(Number(rule.priority || 0), 150) / 1000;
}

function bestByScore(reactions, query) {
    return reactions
        .map(reaction => ({ reaction, score: scoreReaction(query, reaction) }))
        .sort((a, b) => b.score - a.score)[0] || null;
}

function bestFuzzyMatch(query, reactions) {
    const scored = reactions
        .map(reaction => ({ reaction, score: scoreReaction(query, reaction) }))
        .sort((a, b) => b.score - a.score);
    const best = scored[0] || null;
    return best && best.score >= REACTION_FUZZY_THRESHOLD ? best : null;
}

export function searchReactionDatabaseByQuery(query, reactions = REACTION_SEARCH_RULES) {
    const normalizedQuery = norm(query);
    console.log('[MascotSearch] query:', query);
    console.log('[MascotSearch] normalized query:', normalizedQuery);

    const exactKeywordMatches = reactions.filter(reaction => hasExactKeywordMatch(query, reaction));
    console.log('[MascotSearch] exact keyword matches:', exactKeywordMatches.map(reaction => ({
        id: reaction.id,
        name: normalizedReaction(reaction).name
    })));

    const fuzzyScores = reactions
        .map(reaction => ({
            id: reaction.id,
            name: normalizedReaction(reaction).name,
            score: scoreReaction(query, reaction)
        }))
        .sort((a, b) => b.score - a.score);
    console.log('[MascotSearch] fuzzy scores:', fuzzyScores.slice(0, 8));

    if (exactKeywordMatches.length > 0) {
        const selected = bestByScore(exactKeywordMatches, query);
        console.log('[MascotSearch] selected reaction:', selected ? normalizedReaction(selected.reaction).name : undefined);
        console.log('[MascotSearch] selected reason:', 'exact keyword match');
        return selected?.reaction || null;
    }

    const fuzzy = bestFuzzyMatch(query, reactions);
    console.log('[MascotSearch] selected reaction:', fuzzy ? normalizedReaction(fuzzy.reaction).name : undefined);
    console.log('[MascotSearch] selected reason:', fuzzy ? `fuzzy score ${fuzzy.score}` : 'fuzzy score below threshold');
    return fuzzy?.reaction || null;
}

function alternatives(spec) {
    return String(spec || '').split('|').map(s => s.trim()).filter(Boolean);
}

function matchSpecies(ctx, spec) {
    return alternatives(spec).some(name => has(ctx, name));
}

function matchReactants(ctx, reactants = []) {
    return reactants.every(spec => matchSpecies(ctx, spec));
}

function matchExisting(ctx, required = []) {
    return required.every(spec => matchSpecies(ctx, spec));
}

function matchConditions(ctx, conditions = {}) {
    if (conditions.minTemperature !== undefined && ctx.temperature < conditions.minTemperature) return false;
    if (conditions.maxTemperature !== undefined && ctx.temperature > conditions.maxTemperature) return false;
    if (conditions.environment && ctx.environment !== conditions.environment) return false;
    if (conditions.notEnvironment && ctx.environment === conditions.notEnvironment) return false;
    if (conditions.catalyst && !has(ctx, conditions.catalyst)) return false;
    if (conditions.proximity !== undefined && ctx.distance > conditions.proximity) return false;
    if (conditions.notExisting && conditions.notExisting.some(spec => matchSpecies(ctx, spec))) return false;
    if (conditions.excess) {
        const reagent = ctx.amount(conditions.excess.reagent);
        const over = (conditions.excess.over || []).reduce((sum, name) => sum + ctx.amount(name), 0);
        if (over <= 0 || reagent < over * (conditions.excess.ratio || 1)) return false;
    }
    return true;
}

function checkConditionsDetailed(ctx, conditions = {}) {
    const pendingReason = [];
    const failedReason = [];
    if (conditions.minTemperature !== undefined && ctx.temperature < conditions.minTemperature) pendingReason.push('temperature');
    if (conditions.maxTemperature !== undefined && ctx.temperature > conditions.maxTemperature) failedReason.push('temperature');
    if (conditions.environment && ctx.environment !== conditions.environment) failedReason.push('environment');
    if (conditions.notEnvironment && ctx.environment === conditions.notEnvironment) failedReason.push('environment');
    if (conditions.catalyst && !has(ctx, conditions.catalyst)) failedReason.push('catalyst');
    if (conditions.proximity !== undefined && ctx.distance > conditions.proximity) failedReason.push('proximity');
    if (conditions.notExisting && conditions.notExisting.some(spec => matchSpecies(ctx, spec))) failedReason.push('notExisting');
    if (conditions.excess) {
        const reagent = ctx.amount(conditions.excess.reagent);
        const over = (conditions.excess.over || []).reduce((sum, name) => sum + ctx.amount(name), 0);
        if (over <= 0 || reagent < over * (conditions.excess.ratio || 1)) failedReason.push('excess');
    }
    return {
        ok: pendingReason.length === 0 && failedReason.length === 0,
        pending: pendingReason.length > 0 && failedReason.length === 0,
        pendingReason,
        failedReason
    };
}

function materializeRule(rule) {
    const out = {
        ...rule.result,
        id: rule.id,
        name: displayNameFromRule(rule),
        aliases: Array.isArray(rule.aliases) ? rule.aliases : [],
        keywords: Array.isArray(rule.keywords) ? rule.keywords : [],
        reactants: rule.reactants || [],
        requiredExistingSpecies: rule.requiredExistingSpecies || [],
        conditions: rule.conditions || {},
        products: rule.products || rule.result?.products || [],
        phenomenon: phenomenonFromRule(rule),
        effects: rule.effects || rule.result?.effects || [],
        priority: rule.priority || 0,
        consumes: rule.consumes || rule.result?.consumes || {},
        producesState: rule.producesState || rule.result?.producesState || {},
        requiredSetup: rule.requiredSetup || rule.required_setup || rule.result?.requiredSetup || rule.result?.required_setup || {},
        required_setup: rule.requiredSetup || rule.required_setup || rule.result?.requiredSetup || rule.result?.required_setup || {},
        has_reaction: true
    };

    for (const fx of out.effects) {
        if (fx.type === 'precipitate') {
            out.precipitate = true;
            out.precipitateColor = fx.color || out.precipitateColor || '#ffffff';
        }
        if (fx.type === 'gas') {
            out.gas = fx.intensity ?? out.gas ?? 1;
            out.gasColor = fx.color || out.gasColor;
        }
        if (fx.type === 'smoke') {
            out.smoke = fx.intensity ?? out.smoke ?? 1;
            out.smokeColor = fx.color || out.smokeColor;
        }
        if (fx.type === 'fire') out.fire = fx.intensity ?? out.fire ?? 1;
        if (fx.type === 'heat') out.heat = fx.intensity ?? out.heat ?? 1;
        if (fx.type === 'foam') out.foam = true;
        if (fx.type === 'dissolvePrecipitate') out.dissolvePrecipitate = true;
        if (fx.type === 'mirrorSilver') out.mirrorCoating = true;
        if (fx.type === 'phaseSeparation') out.twoLayerLiquid = true;
        if (fx.type === 'decolorize') out.decolorize = true;
    }
    out.raw = { ...out };
    return out;
}

export function getReactionPool(source, target) {
    const ctx = makeContext(source, target);
    return Array.from(ctx.species.values()).map(v => v.name);
}

export function findLocalReaction(source, target) {
    const ctx = makeContext(source, target);
    const sorted = [...LOCAL_REACTION_RULES].sort((a, b) => (b.priority || 0) - (a.priority || 0));
    let pendingTemperature = null;
    for (const rule of sorted) {
        if (!matchReactants(ctx, rule.reactants || [])) continue;
        if (!matchExisting(ctx, rule.requiredExistingSpecies || [])) continue;
        const conditionResult = checkConditionsDetailed(ctx, rule.conditions || {});
        if (!conditionResult.ok) {
            if (conditionResult.pending && !pendingTemperature) {
                const materialized = materializeRule(rule);
                pendingTemperature = {
                    has_reaction: false,
                    pending_reaction: true,
                    pendingReason: conditionResult.pendingReason,
                    pendingReaction: {
                        ...materialized,
                        heating_required: true,
                        target_temperature: rule.conditions?.minTemperature ?? null,
                        temperature_tolerance: rule.conditions?.temperatureTolerance ?? 5
                    },
                    requiredTemperature: rule.conditions?.minTemperature ?? null,
                    currentTemperature: ctx.temperature,
                    reason: 'pending_temperature'
                };
            }
            continue;
        }
        return materializeRule(rule);
    }
    if (pendingTemperature) return pendingTemperature;
    return {
        has_reaction: false,
        reason: 'no_local_rule',
        pool: Array.from(ctx.species.values()).map(v => `${v.name}:${v.amount}`),
        environment: ctx.environment,
        temperature: ctx.temperature
    };
}
