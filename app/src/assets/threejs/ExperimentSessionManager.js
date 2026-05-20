const DEFAULT_LIQUID_AMOUNT = 5;
const DEFAULT_SOLID_AMOUNT = 0.5;
const ACTION_DEBOUNCE_MS = 10000;

let currentExperimentPlan = window.currentExperimentPlan || null;
let actionStep = 0;
let lastRecordedAction = null;

function norm(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/[()[\]{}]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const ALIASES = new Map([
    ['hcl', 'axit clohidric'],
    ['hydrochloric acid', 'axit clohidric'],
    ['h2so4', 'axit sunfuric'],
    ['sulfuric acid', 'axit sunfuric'],
    ['hno3', 'axit nitric'],
    ['ch3cooh', 'axit axetic'],
    ['acetic acid', 'axit axetic'],
    ['naoh', 'natri hydroxit'],
    ['nh3', 'amoniac'],
    ['ammonia', 'amoniac'],
    ['agno3', 'bac nitrat'],
    ['silver nitrate', 'bac nitrat'],
    ['cuso4', 'dong ii sunfat'],
    ['dong 2 sunfat', 'dong ii sunfat'],
    ['copper ii sulfate', 'dong ii sunfat'],
    ['bacl2', 'bari clorua'],
    ['kmno4', 'kali pemanganat'],
    ['mno2', 'mangan dioxit'],
    ['glucose', 'glucozo'],
    ['glucozo', 'glucozo'],
    ['c2h5oh', 'ancol etylic'],
    ['ethanol', 'ancol etylic'],
    ['na', 'natri'],
    ['h2o', 'nuoc'],
    ['water', 'nuoc']
]);

function key(value) {
    const normalized = norm(value);
    return ALIASES.get(normalized) || normalized;
}

function displayName(value) {
    return String(value || '').trim() || 'hóa chất chưa xác định';
}

function sourceName(source) {
    const u = source?.userData || {};
    return displayName(
        u.current_chemical_name ||
        u.chemicalName ||
        u.name_vi ||
        u.formula ||
        u.current_chemical_type ||
        u.chemicalType ||
        u.chemical_type ||
        u.id_chemical
    );
}

function sourceState(source) {
    const u = source?.userData || {};
    const raw = String(
        u.current_physical_state ||
        u.physical_state ||
        u.physicalState ||
        u.state ||
        ''
    ).toLowerCase();
    if (raw.includes('rắn') || raw.includes('ran') || raw.includes('solid') || raw.includes('powder') || raw.includes('bột')) {
        return 'solid';
    }
    return 'liquid';
}

function defaultQuantityForSource(source) {
    return sourceState(source) === 'solid'
        ? { amount: DEFAULT_SOLID_AMOUNT, unit: 'g' }
        : { amount: DEFAULT_LIQUID_AMOUNT, unit: 'ml' };
}

function plannedAddSteps() {
    return (currentExperimentPlan?.required_conditions?.steps || [])
        .filter(step => step?.action === 'add_chemical');
}

function nextIncompleteStep(container) {
    const contents = aggregateContents(container);
    return plannedAddSteps().find(step => {
        const required = Number(step.amount || 0);
        const tolerance = findRequiredChemical(step.chemical)?.tolerance ?? 0;
        const current = contents.get(key(step.chemical))?.amount || 0;
        return current < Math.max(0, required - tolerance);
    });
}

function ensureQuantityControl() {
    let control = document.getElementById('experiment-quantity-control');
    if (control) return control;

    control = document.createElement('div');
    control.id = 'experiment-quantity-control';
    control.className = 'experiment-quantity-control hidden';
    control.innerHTML = `
        <label for="experiment-amount-input">Lượng rót</label>
        <div class="experiment-quantity-row">
            <input id="experiment-amount-input" type="number" min="0" step="0.1" value="${DEFAULT_LIQUID_AMOUNT}">
            <select id="experiment-unit-select" aria-label="Đơn vị lượng hóa chất">
                <option value="ml">ml</option>
                <option value="g">g</option>
            </select>
        </div>
    `;
    document.body.appendChild(control);
    return control;
}

function setQuantityControlVisible(visible) {
    const control = ensureQuantityControl();
    control.classList.toggle('hidden', !visible);
}

function setQuantityControlValue(amount, unit) {
    const control = ensureQuantityControl();
    const input = control.querySelector('#experiment-amount-input');
    const select = control.querySelector('#experiment-unit-select');
    if (input && Number.isFinite(Number(amount))) input.value = String(amount);
    if (select && unit) select.value = unit;
}

function syncQuantityForNextStep(container = null) {
    if (!currentExperimentPlan) return;
    const step = nextIncompleteStep(container) || plannedAddSteps()[0];
    if (step) setQuantityControlValue(step.amount, step.unit);
}

export function setCurrentExperimentPlan(plan) {
    currentExperimentPlan = plan || null;
    window.currentExperimentPlan = currentExperimentPlan;
    window.experimentSession = {
        plan: currentExperimentPlan,
        actions: [],
        startedAt: Date.now()
    };
    actionStep = 0;
    lastRecordedAction = null;
    setQuantityControlVisible(!!currentExperimentPlan);
    syncQuantityForNextStep();
    return currentExperimentPlan;
}

export function getCurrentExperimentPlan() {
    return currentExperimentPlan || window.currentExperimentPlan || null;
}

export function hasActiveExperimentPlan() {
    return !!getCurrentExperimentPlan();
}

export function getSelectedQuantity(source) {
    const fallback = defaultQuantityForSource(source);
    const input = document.getElementById('experiment-amount-input');
    const select = document.getElementById('experiment-unit-select');
    const amount = Number(input?.value);
    const unit = select?.value || fallback.unit;

    if (!hasActiveExperimentPlan() || !Number.isFinite(amount) || amount <= 0) {
        return fallback;
    }
    return { amount, unit };
}

export function ensureContainerExperimentState(container) {
    if (!container?.userData) return null;
    if (!container.userData.experimentState) {
        container.userData.experimentState = {
            contents: [],
            totalVolume: 0,
            temperature: Number(container.userData.temperature ?? container.userData.currentTemperature ?? 25),
            hasBeenHeated: !!container.userData.hasBeenHeated,
            reactionHistory: []
        };
    }
    const state = container.userData.experimentState;
    state.temperature = Number(container.userData.temperature ?? container.userData.currentTemperature ?? state.temperature ?? 25);
    state.hasBeenHeated = !!(state.hasBeenHeated || container.userData.hasBeenHeated || state.temperature > 35);
    return state;
}

export function recordPourAction({ source, target, amount, unit, physicalState } = {}) {
    if (!target?.userData || !source?.userData) return { recorded: false };
    const name = sourceName(source);
    const now = performance.now();
    const actionKey = `${source.uuid || name}->${target.uuid || 'container'}`;
    if (
        lastRecordedAction &&
        lastRecordedAction.key === actionKey &&
        now - lastRecordedAction.time < ACTION_DEBOUNCE_MS
    ) {
        return { recorded: false, action: lastRecordedAction.action };
    }

    const quantityAmount = Number(amount) || defaultQuantityForSource(source).amount;
    const quantityUnit = unit || defaultQuantityForSource(source).unit;
    const state = ensureContainerExperimentState(target);
    const action = {
        step: ++actionStep,
        type: 'add_chemical',
        chemicalName: name,
        amount: quantityAmount,
        unit: quantityUnit,
        physicalState: physicalState || sourceState(source),
        targetId: target.uuid || null,
        timestamp: Date.now()
    };

    state.contents.push({
        chemicalName: name,
        amount: quantityAmount,
        unit: quantityUnit,
        physicalState: action.physicalState,
        addedAtStep: action.step
    });
    if (quantityUnit === 'ml') state.totalVolume += quantityAmount;

    if (!window.experimentSession) {
        window.experimentSession = { plan: getCurrentExperimentPlan(), actions: [], startedAt: Date.now() };
    }
    window.experimentSession.actions.push(action);
    lastRecordedAction = { key: actionKey, time: now, action };
    syncQuantityForNextStep(target);
    return { recorded: true, action };
}

function aggregateContents(container) {
    const state = ensureContainerExperimentState(container);
    const map = new Map();
    (state?.contents || []).forEach(item => {
        const itemKey = key(item.chemicalName);
        const current = map.get(itemKey) || {
            name: item.chemicalName,
            amount: 0,
            units: new Set()
        };
        current.amount += Number(item.amount) || 0;
        current.units.add(item.unit);
        map.set(itemKey, current);
    });
    return map;
}

function findRequiredChemical(name) {
    const required = currentExperimentPlan?.required_chemicals || [];
    return required.find(item => key(item.name_vi || item.name_en) === key(name));
}

function fail(reason, message) {
    return { ok: false, reason, message };
}

function validateOrder(container) {
    const conditions = currentExperimentPlan?.required_conditions || {};
    if (!conditions.order_required) return null;

    const expected = plannedAddSteps();
    const state = ensureContainerExperimentState(container);
    const compressed = [];
    (state?.contents || []).forEach(item => {
        const itemKey = key(item.chemicalName);
        const last = compressed[compressed.length - 1];
        if (last && last.key === itemKey) {
            last.amount += Number(item.amount) || 0;
        } else {
            compressed.push({ key: itemKey, name: item.chemicalName, amount: Number(item.amount) || 0 });
        }
    });

    for (let i = 0; i < compressed.length; i += 1) {
        if (!expected[i]) {
            return fail('wrong_order', `Bạn đã thêm ${compressed[i].name} ngoài quy trình của thí nghiệm này.`);
        }
        if (compressed[i].key !== key(expected[i].chemical)) {
            return fail('wrong_order', `Sai thứ tự: bước ${i + 1} cần ${expected[i].chemical}, nhưng bạn đã thêm ${compressed[i].name}.`);
        }
    }
    return null;
}

function validateAmounts(container) {
    const required = currentExperimentPlan?.required_chemicals || [];
    const contents = aggregateContents(container);
    const requiredKeys = new Set(required.map(item => key(item.name_vi || item.name_en)));

    for (const actual of contents.values()) {
        if (!requiredKeys.has(key(actual.name))) {
            return fail('wrong_chemical', `Sai chất: bạn đã dùng ${actual.name}. Thí nghiệm này không cần chất đó.`);
        }
    }

    for (const item of required) {
        const name = item.name_vi || item.name_en;
        const current = contents.get(key(name))?.amount || 0;
        const amount = Number(item.amount || 0);
        const tolerance = Number(item.tolerance || 0);
        if (current <= 0) {
            return fail('missing_chemical', `Bạn chưa lấy ${name}. Cần ${amount} ${item.unit}.`);
        }
        if (current < amount - tolerance) {
            const missing = Math.max(0, amount - current);
            return fail('wrong_amount', `Bạn đã lấy ${current.toFixed(2)} ${item.unit} ${name}, cần thêm khoảng ${missing.toFixed(2)} ${item.unit}.`);
        }
        if (current > amount + tolerance) {
            const extra = current - amount;
            return fail('wrong_amount', `Lượng ${name} đang dư khoảng ${extra.toFixed(2)} ${item.unit}. Cần ${amount} ${item.unit} (sai số ${tolerance} ${item.unit}).`);
        }
    }
    return null;
}

function validateTemperature(container) {
    const conditions = currentExperimentPlan?.required_conditions || {};
    const state = ensureContainerExperimentState(container);
    const temp = Number(state?.temperature ?? 25);

    if (conditions.heating_required && !state?.hasBeenHeated) {
        const min = conditions.temperature_min;
        return fail('wrong_temperature', min ? `Cần đun nóng đến trên ${min}°C trước khi phản ứng thành công.` : 'Cần đun nóng trước khi phản ứng thành công.');
    }
    if (conditions.temperature_min !== null && conditions.temperature_min !== undefined && temp < Number(conditions.temperature_min)) {
        return fail('wrong_temperature', `Nhiệt độ hiện khoảng ${temp}°C, cần trên ${conditions.temperature_min}°C.`);
    }
    if (conditions.temperature_max !== null && conditions.temperature_max !== undefined && temp > Number(conditions.temperature_max)) {
        return fail('wrong_temperature', `Nhiệt độ hiện khoảng ${temp}°C, cần dưới ${conditions.temperature_max}°C.`);
    }
    return null;
}

export function describeNextRequirement(container) {
    if (!hasActiveExperimentPlan()) return '';
    const orderIssue = validateOrder(container);
    if (orderIssue) return orderIssue.message;

    const next = nextIncompleteStep(container);
    if (next) {
        const contents = aggregateContents(container);
        const current = contents.get(key(next.chemical))?.amount || 0;
        const remaining = Math.max(0, Number(next.amount || 0) - current);
        if (current > 0) {
            return `Đúng rồi. Bạn đã lấy ${current} ${next.unit} ${next.chemical}, cần thêm khoảng ${remaining.toFixed(2)} ${next.unit}.`;
        }
        return `Tiếp tục: bạn cần lấy ${next.amount} ${next.unit} ${next.chemical}.`;
    }

    const tempIssue = validateTemperature(container);
    if (tempIssue) return tempIssue.message;
    return 'Đúng rồi, các hóa chất và lượng đã khớp đề bài. Có thể tiếp tục phản ứng.';
}

export function validateExperimentBeforeReaction({ target } = {}) {
    currentExperimentPlan = getCurrentExperimentPlan();
    if (!currentExperimentPlan) return { ok: true };
    if (!target?.userData) return fail('missing_container', 'Chưa xác định được dụng cụ chứa để kiểm tra thí nghiệm.');

    const orderIssue = validateOrder(target);
    if (orderIssue) return orderIssue;

    const amountIssue = validateAmounts(target);
    if (amountIssue) return amountIssue;

    const temperatureIssue = validateTemperature(target);
    if (temperatureIssue) return temperatureIssue;

    return { ok: true, message: currentExperimentPlan.success_message || 'Thí nghiệm thành công.' };
}

export function markReactionSuccess(container, reaction = null) {
    if (!container?.userData) return;
    const state = ensureContainerExperimentState(container);
    state.reactionHistory.push({
        reactionId: reaction?.id || reaction?.rule_id || reaction?.success_reaction_id || currentExperimentPlan?.success_reaction_id || null,
        at: Date.now()
    });
}

export function markContainerHeated(container, temperature = 80) {
    if (!container?.userData) return;
    container.userData.temperature = temperature;
    container.userData.currentTemperature = temperature;
    container.userData.hasBeenHeated = true;
    const state = ensureContainerExperimentState(container);
    state.temperature = temperature;
    state.hasBeenHeated = true;
}

window.setCurrentExperimentPlan = setCurrentExperimentPlan;
window.getCurrentExperimentPlan = getCurrentExperimentPlan;
window.markExperimentHeated = markContainerHeated;

if (currentExperimentPlan) {
    setCurrentExperimentPlan(currentExperimentPlan);
}
