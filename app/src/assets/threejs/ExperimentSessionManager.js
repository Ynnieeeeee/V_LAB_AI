const DEFAULT_LIQUID_AMOUNT = 5;
const DEFAULT_SOLID_AMOUNT = 0.5;
const LIQUID_FLOW_PER_TICK = 0.5;
const SOLID_FLOW_PER_TICK = 0.05;
const STEP_SYNC_THROTTLE_MS = 250;

let currentExperimentPlan = window.currentExperimentPlan || null;
let currentExperimentSteps = window.currentExperimentSteps || [];
let currentStep = null;
let actionStep = 0;
const lastStepSyncAt = new Map();

function norm(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Ä‘/g, 'd')
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

function stepIsChemicalAction(step) {
    const action = step?.action_type || step?.action;
    return action === 'pour' || action === 'add' || action === 'add_chemical';
}

function hasQuantityTarget(item) {
    const amount = item?.target_amount ?? item?.amount;
    return amount !== null
        && amount !== undefined
        && Number.isFinite(Number(amount))
        && !!item?.unit;
}

function targetAmountOrNull(item) {
    return hasQuantityTarget(item) ? Number(item.target_amount ?? item.amount) : null;
}

function toleranceOrNull(item) {
    return item?.tolerance === null || item?.tolerance === undefined ? null : Number(item.tolerance);
}

function activeChemicalSteps() {
    if (currentExperimentSteps.length) {
        return currentExperimentSteps
            .filter(stepIsChemicalAction)
            .map(step => ({
                step: step.step_order,
                chemical: step.chemical_name_vi,
                canonical_id: step.canonical_id,
                amount: targetAmountOrNull(step),
                unit: step.unit,
                tolerance: toleranceOrNull(step),
                actual_amount: Number(step.actual_amount || 0),
                is_completed: !!step.is_completed,
                dbStep: step
            }));
    }
    return (currentExperimentPlan?.required_conditions?.steps || [])
        .filter(step => step?.action === 'add_chemical');
}

function plannedAddSteps() {
    return activeChemicalSteps();
}

function updateCurrentStep(container = null) {
    currentStep = nextIncompleteStep(container) || null;
    if (!window.experimentSession) window.experimentSession = { actions: [], startedAt: Date.now() };
    window.experimentSession.currentStep = currentStep;
    window.currentExperimentStep = currentStep;
    return currentStep;
}

function nextIncompleteStep(container) {
    if (currentExperimentSteps.length) {
        return plannedAddSteps().find(step => {
            if (!hasQuantityTarget(step)) return !step.is_completed;
            const required = Number(step.amount || 0);
            const current = Number(step.actual_amount || 0);
            return current < required;
        });
    }
    const contents = aggregateContents(container);
    return plannedAddSteps().find(step => {
        if (!hasQuantityTarget(step)) return !contents.has(key(step.chemical));
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
    if (step && hasQuantityTarget(step)) setQuantityControlValue(step.amount, step.unit);
}

function buildPlanFromSteps(steps, basePlan = currentExperimentPlan) {
    if (!steps.length) return basePlan || null;
    const chemicalSteps = steps.filter(stepIsChemicalAction);
    const requiredChemicals = chemicalSteps.map(step => ({
        canonical_id: step.canonical_id,
        name_vi: step.chemical_name_vi,
        name_en: step.chemical_name_vi,
        amount: targetAmountOrNull(step),
        unit: step.unit,
        tolerance: toleranceOrNull(step),
        role: 'reactant'
    }));
    const legacySteps = steps.map(step => ({
        step: step.step_order,
        action: step.action_type === 'heat' ? 'heat' : 'add_chemical',
        chemical: step.chemical_name_vi,
        canonical_id: step.canonical_id,
        amount: targetAmountOrNull(step),
        unit: step.unit,
        temperature_min: step.target_temperature
    }));
    const heatingStep = steps.find(step => step.action_type === 'heat' || step.heating_required);
    return {
        ...(basePlan || {}),
        experiment_id: basePlan?.experiment_id || 'planned_experiment',
        reaction_id: basePlan?.reaction_id || basePlan?.success_reaction_id || null,
        title: basePlan?.title || 'Thí nghiệm đã lưu',
        steps,
        required_chemicals: requiredChemicals,
        required_conditions: {
            ...(basePlan?.required_conditions || {}),
            order_required: true,
            heating_required: !!heatingStep,
            temperature_min: heatingStep?.target_temperature ?? basePlan?.required_conditions?.temperature_min ?? null,
            temperature_max: basePlan?.required_conditions?.temperature_max ?? null,
            steps: legacySteps
        },
        success_reaction_id: basePlan?.success_reaction_id || basePlan?.reaction_id || null,
        success_message: basePlan?.success_message || 'Thí nghiệm thành công.'
    };
}

export function setCurrentExperimentPlan(plan) {
    currentExperimentPlan = plan || null;
    currentExperimentSteps = Array.isArray(plan?.steps)
        ? plan.steps.filter(step => step?.id_step)
        : [];
    window.currentExperimentPlan = currentExperimentPlan;
    window.currentExperimentSteps = currentExperimentSteps;
    window.experimentSession = {
        plan: currentExperimentPlan,
        steps: currentExperimentSteps,
        currentStep: null,
        actions: [],
        startedAt: Date.now()
    };
    actionStep = 0;
    setQuantityControlVisible(!!currentExperimentPlan);
    syncQuantityForNextStep();
    updateCurrentStep();
    return currentExperimentPlan;
}

export function setCurrentExperimentSteps(steps = []) {
    currentExperimentSteps = Array.isArray(steps)
        ? steps.map(step => ({
            ...step,
            target_amount: step.target_amount === null || step.target_amount === undefined ? null : Number(step.target_amount),
            tolerance: step.tolerance === null || step.tolerance === undefined ? 0 : Number(step.tolerance),
            actual_amount: Number(step.actual_amount || 0),
            is_completed: !!step.is_completed,
            is_failed: !!step.is_failed,
            auto_stop: step.auto_stop !== false
        })).sort((a, b) => Number(a.step_order || 0) - Number(b.step_order || 0))
        : [];
    window.currentExperimentSteps = currentExperimentSteps;
    currentExperimentPlan = buildPlanFromSteps(currentExperimentSteps, currentExperimentPlan);
    window.currentExperimentPlan = currentExperimentPlan;
    if (!window.experimentSession) window.experimentSession = { actions: [], startedAt: Date.now() };
    window.experimentSession.plan = currentExperimentPlan;
    window.experimentSession.steps = currentExperimentSteps;
    setQuantityControlVisible(!!currentExperimentPlan);
    syncQuantityForNextStep();
    updateCurrentStep();
    return currentExperimentSteps;
}

export async function fetchExperimentSteps(idConversation = window.currentConvId || localStorage.getItem('lab_conv_id')) {
    if (!idConversation) return [];
    const token = localStorage.getItem('access_token');
    if (!token) return [];
    const response = await fetch(`/api/experiment-steps/${idConversation}`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
        console.error('Experiment steps fetch failed:', response.status, await response.text().catch(() => ''));
        return [];
    }
    const data = await response.json();
    return setCurrentExperimentSteps(data.steps || []);
}

export function getCurrentExperimentPlan() {
    return currentExperimentPlan || window.currentExperimentPlan || null;
}

export function getCurrentStep(container = null) {
    return updateCurrentStep(container);
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

function currentDbStepForSource(source) {
    if (!currentExperimentSteps.length) return null;
    return currentExperimentSteps.find(step => stepIsChemicalAction(step) && !step.is_completed) || null;
}

function flowIncrementFor(source, step = null) {
    const unit = step?.unit || defaultQuantityForSource(source).unit;
    return unit === 'g' ? SOLID_FLOW_PER_TICK : LIQUID_FLOW_PER_TICK;
}

function syncStepActualAmount(step, force = false) {
    if (!step?.id_step) return;
    const token = localStorage.getItem('access_token');
    if (!token) return;
    const now = performance.now();
    const last = lastStepSyncAt.get(step.id_step) || 0;
    if (!force && now - last < STEP_SYNC_THROTTLE_MS) return;
    lastStepSyncAt.set(step.id_step, now);
    fetch(`/api/experiment-steps/${step.id_step}`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
            actual_amount: step.actual_amount,
            is_completed: step.is_completed
        })
    })
        .then(response => response.ok ? response.json() : Promise.reject(response))
        .then(updated => {
            const index = currentExperimentSteps.findIndex(item => item.id_step === updated.id_step);
            if (index >= 0) {
                currentExperimentSteps[index] = { ...currentExperimentSteps[index], ...updated };
                setCurrentExperimentSteps(currentExperimentSteps);
            }
        })
        .catch(error => console.error('Experiment step sync failed:', error));
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
    const dbStep = currentDbStepForSource(source);
    const sameAsCurrentStep = !dbStep || key(dbStep.chemical_name_vi) === key(name);
    const hasDbTarget = dbStep?.target_amount !== null
        && dbStep?.target_amount !== undefined
        && Number.isFinite(Number(dbStep.target_amount))
        && !!dbStep.unit;
    const remaining = hasDbTarget
        ? Math.max(0, Number(dbStep.target_amount) - Number(dbStep.actual_amount || 0))
        : Infinity;
    const fallbackQuantity = defaultQuantityForSource(source);
    const tickAmount = dbStep && sameAsCurrentStep
        ? Math.min(flowIncrementFor(source, dbStep), remaining)
        : (dbStep ? fallbackQuantity.amount : (Number(amount) || fallbackQuantity.amount));
    if (dbStep && sameAsCurrentStep && hasDbTarget && remaining <= 0) {
        return {
            recorded: false,
            dbStep,
            autoStopped: !!dbStep.auto_stop,
            message: `Đã đủ ${dbStep.target_amount} ${dbStep.unit} ${dbStep.chemical_name_vi}.`
        };
    }
    const numericTickAmount = Number(tickAmount);
    const quantityAmount = Number.isFinite(numericTickAmount)
        ? numericTickAmount
        : fallbackQuantity.amount;
    const quantityUnit = dbStep && sameAsCurrentStep
        ? (dbStep.unit || fallbackQuantity.unit)
        : (dbStep ? fallbackQuantity.unit : (unit || fallbackQuantity.unit));
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

    let autoStopped = false;
    let completedStep = null;
    if (dbStep && sameAsCurrentStep) {
        const nextActualAmount = Number(dbStep.actual_amount || 0) + quantityAmount;
        dbStep.actual_amount = hasDbTarget
            ? Math.min(Number(dbStep.target_amount), nextActualAmount)
            : nextActualAmount;
        dbStep.is_completed = hasDbTarget
            ? Number(dbStep.actual_amount || 0) >= Number(dbStep.target_amount)
            : Number(dbStep.actual_amount || 0) > 0;
        completedStep = dbStep;
        autoStopped = hasDbTarget && !!dbStep.auto_stop && dbStep.is_completed;
        syncStepActualAmount(dbStep, autoStopped || (!hasDbTarget && dbStep.is_completed));
    }

    syncQuantityForNextStep(target);
    updateCurrentStep(target);
    return {
        recorded: true,
        action,
        dbStep: completedStep,
        autoStopped,
        message: autoStopped && completedStep
            ? `Đã đủ ${completedStep.target_amount} ${completedStep.unit} ${completedStep.chemical_name_vi}.`
            : ''
    };
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
    const step = activeChemicalSteps().find(item => key(item.chemical) === key(name));
    if (step) {
        return {
            name_vi: step.chemical,
            amount: step.amount,
            unit: step.unit,
            tolerance: step.tolerance
        };
    }
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
    const required = currentExperimentSteps.length
        ? activeChemicalSteps().map(step => ({
            canonical_id: step.canonical_id,
            name_vi: step.chemical,
            amount: step.amount,
            unit: step.unit,
            tolerance: step.tolerance
        }))
        : (currentExperimentPlan?.required_chemicals || []);
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
        const hasAmountTarget = hasQuantityTarget(item);
        if (current <= 0) {
            return fail(
                'missing_chemical',
                hasAmountTarget
                    ? `Bạn chưa lấy ${name}. Cần ${item.amount} ${item.unit}.`
                    : `Bạn chưa thêm ${name}. Cơ sở dữ liệu chưa có định lượng cho chất này.`
            );
        }
        if (!hasAmountTarget) {
            continue;
        }

        const amount = Number(item.amount);
        const tolerance = Number(item.tolerance || 0);
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
        if (next.dbStep) {
            const hasTarget = next.dbStep.target_amount !== null
                && next.dbStep.target_amount !== undefined
                && Number.isFinite(Number(next.dbStep.target_amount));
            if (!hasTarget) {
                return `Tiếp tục: thêm ${next.dbStep.chemical_name_vi}. Chưa có dữ liệu định lượng trong cơ sở dữ liệu.`;
            }
            const current = Number(next.dbStep.actual_amount || 0);
            const remaining = Math.max(0, Number(next.dbStep.target_amount || 0) - current);
            if (current > 0) {
                return `Đúng rồi. Bạn đã rót ${current.toFixed(2)} ${next.dbStep.unit} ${next.dbStep.chemical_name_vi}, cần thêm khoảng ${remaining.toFixed(2)} ${next.dbStep.unit}.`;
            }
            return `Tiếp tục: bạn cần ${next.dbStep.action_type === 'add' ? 'thêm' : 'rót'} ${next.dbStep.target_amount} ${next.dbStep.unit} ${next.dbStep.chemical_name_vi}.`;
        }
        const contents = aggregateContents(container);
        const current = contents.get(key(next.chemical))?.amount || 0;
        if (!hasQuantityTarget(next)) {
            if (current > 0) {
                return `Đã thêm ${next.chemical}. Cơ sở dữ liệu chưa có định lượng cho bước này.`;
            }
            return `Tiếp tục: thêm ${next.chemical}. Chưa có dữ liệu định lượng trong cơ sở dữ liệu.`;
        }
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

export function validateExperimentBeforeReaction({ target, skipTemperature = false } = {}) {
    currentExperimentPlan = getCurrentExperimentPlan();
    if (!currentExperimentPlan) return { ok: true };
    if (!target?.userData) return fail('missing_container', 'Chưa xác định được dụng cụ chứa để kiểm tra thí nghiệm.');

    const orderIssue = validateOrder(target);
    if (orderIssue) return orderIssue;

    const amountIssue = validateAmounts(target);
    if (amountIssue) return amountIssue;

    if (!skipTemperature) {
        const temperatureIssue = validateTemperature(target);
        if (temperatureIssue) return temperatureIssue;
    }

    return { ok: true, message: currentExperimentPlan.success_message || 'Thí nghiệm thành công.' };
}

export function validateReactionResult(reaction) {
    currentExperimentPlan = getCurrentExperimentPlan();
    if (!currentExperimentPlan || !reaction?.has_reaction) return { ok: true };

    const expected = currentExperimentPlan.reaction_id || currentExperimentPlan.success_reaction_id;
    if (!expected || expected === 'validated_reaction') return { ok: true };

    const actual = reaction.id ||
        reaction.rule_id ||
        reaction.success_reaction_id ||
        reaction.raw?.id ||
        reaction.raw?.rule_id ||
        reaction.raw?.reaction_id;

    if (actual && actual === expected) return { ok: true };
    return fail(
        'wrong_reaction',
        `Phản ứng tạo ra (${actual || 'không xác định'}) không khớp reaction_id cần dùng: ${expected}.`
    );
}

export function markReactionSuccess(container, reaction = null) {
    if (!container?.userData) return;
    const state = ensureContainerExperimentState(container);
    state.reactionHistory.push({
        reactionId: reaction?.id || reaction?.rule_id || reaction?.success_reaction_id || currentExperimentPlan?.success_reaction_id || null,
        at: Date.now()
    });
}

export function markContainerHeated(container, temperature = null) {
    if (!container?.userData) return;
    const nextTemperature = Number(temperature ?? container.userData.temperature ?? container.userData.currentTemperature ?? 25);
    container.userData.temperature = nextTemperature;
    container.userData.currentTemperature = nextTemperature;
    container.userData.hasBeenHeated = true;
    const state = ensureContainerExperimentState(container);
    state.temperature = nextTemperature;
    state.hasBeenHeated = true;
}

window.setCurrentExperimentPlan = setCurrentExperimentPlan;
window.setCurrentExperimentSteps = setCurrentExperimentSteps;
window.fetchExperimentSteps = fetchExperimentSteps;
window.getCurrentExperimentPlan = getCurrentExperimentPlan;
window.getCurrentExperimentStep = getCurrentStep;
window.markExperimentHeated = markContainerHeated;

if (currentExperimentPlan) {
    setCurrentExperimentPlan(currentExperimentPlan);
}
