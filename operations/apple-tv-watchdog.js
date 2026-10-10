// Eligibility only: native Homey Restart app card owns the actual recovery.
const PREFIX = 'Apple TV AirPlay Watchdog ';
const DEVICE_ID = '6d4183e8-a31e-4809-9b77-cddbea3958c5';
const WAIT_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 30 * 60 * 1000;
const MAX_GAP_MS = 90 * 1000;
const vars = Object.values(await Homey.logic.getVariables());
async function variable(suffix, type, value) {
    let v = vars.find(item => item.name === PREFIX + suffix);
    if (!v) {
        v = await Homey.logic.createVariable({variable: {name: PREFIX + suffix, type, value}});
        vars.push(v);
    }
    if (!v?.id || v.type !== type) throw new Error('Invalid watchdog variable: ' + suffix);
    return v;
}
async function set(v, value) {
    await Homey.logic.updateVariable({id: v.id, variable: {value}});
    v.value = value;
}
const since = await variable('Unavailable Since', 'number', 0);
const checked = await variable('Last Check', 'number', 0);
const restart = await variable('Last Restart', 'number', 0);
const misses = await variable('Misses', 'number', 0);
const status = await variable('Status', 'string', 'Starting checks');
const saved = await variable('History', 'string', '[]');
let history = JSON.parse(saved.value);
if (!Array.isArray(history)) throw new Error('Invalid watchdog history; recovery held');
for (const v of [since, checked, restart, misses]) {
    if (!Number.isFinite(v.value) || v.value < 0) throw new Error('Invalid watchdog timestamp/count; recovery held');
}
async function record(event, detail) {
    history.push({at: new Date().toISOString(), event, detail});
    await set(saved, JSON.stringify(history.slice(-40)));
}
async function reset(text) {
    await set(since, 0);
    await set(misses, 0);
    if (status.value !== text) {
        await record(text === 'Healthy' ? 'availability-verified' : 'coverage-unknown', text);
        await set(status, text);
    }
}
const now = Date.now();
const priorCheck = checked.value;
let device;
try {
    device = await Homey.devices.getDevice({id: DEVICE_ID});
} catch (_) {
    await set(checked, now);
    await reset('Availability read failed; five-minute confirmation reset');
    return false;
}
await set(checked, now);
if (device?.available === true && device.ready === true) {
    await reset('Healthy');
    return false;
}
const offline = device?.available === false || device?.ready === false;
if (!offline) {
    await reset('Availability unknown; five-minute confirmation reset');
    return false;
}
if (!priorCheck || now < priorCheck || now - priorCheck > MAX_GAP_MS || since.value > now) {
    await set(since, 0);
    await set(misses, 0);
}
if (!since.value) {
    await set(since, now);
    await record('unavailable', 'Starting five-minute confirmation from explicit Homey unavailable/not-ready state');
}
await set(misses, misses.value + 1);
if (now < restart.value || (restart.value > 0 && now - restart.value < COOLDOWN_MS)) {
    await set(status, 'Unavailable; app-restart cooldown active');
    return false;
}
if (now - since.value < WAIT_MS) {
    await set(status, 'Unavailable; waiting for five minutes of confirmed observations');
    return false;
}
// Persist intent before the native restart card. Ambiguous outcomes retain cooldown.
await set(restart, now);
await set(since, 0);
await record('restart-requested', 'Five-minute threshold reached; native card restarts only Apple TV & HomePod app');
await set(status, 'Restart requested; recovery requires a later healthy check');
return true;

