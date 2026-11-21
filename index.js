/*
 * Extension Cart (확장 장바구니)
 *
 * Pick an action for many extensions at once (update / enable / disable / delete / reinstall),
 * apply them in one go, and reload the page only once at the end.
 *
 * What this file talks to:
 *   - SillyTavern's own server endpoints under /api/extensions/* (same ones the Manage dialog uses)
 *   - SillyTavern settings (extension_settings.disabledExtensions, and this extension's own settings)
 *   - localStorage of this browser (remembered update-check results)
 * It never contacts any other server and never reads API keys or chats.
 */

import {
    enableExtension,
    disableExtension,
    extension_settings,
    extensionNames,
    extensionTypes,
    getExtensionManifest,
} from '../../../extensions.js';
import { saveSettings, getRequestHeaders } from '../../../../script.js';
import { isAdmin } from '../../../user.js';

const MODULE_NAME = 'ext_cart';
const LOG = '[ext-cart]';
const CACHE_KEY = 'extcart_version_cache_v1';
const THIRD_PARTY = 'third-party/';
const POOL_SIZE = 3;  // how many updates run at the same time
const CHECK_POOL_SIZE = 6; // how many update checks run at the same time (ST itself uses 5)
const VIEW_KEY = 'extcart_view_v1'; // remembered filter of this browser
const HOOK_TIMEOUT = 5000;

/** Internal name of this extension, e.g. "third-party/ext-cart" (taken from where this file was loaded from). */
const SELF = (() => {
    try {
        const path = decodeURIComponent(new URL(import.meta.url).pathname);
        const match = path.match(/\/scripts\/extensions\/(.+)\/[^/]+$/);
        return match ? match[1] : `${THIRD_PARTY}ext-cart`;
    } catch {
        return `${THIRD_PARTY}ext-cart`;
    }
})();

const ACTION_LABEL = Object.freeze({
    update: '업데이트',
    enable: '켜기',
    disable: '끄기',
    delete: '삭제',
    reinstall: '다시 설치',
});

const defaultSettings = Object.freeze({
    autoReload: false, // false: show a reload button, true: reload 3s after a clean run
    ttlHours: 6,       // how long update-check results are remembered
    autoCheck: true,   // check for updates in the background when the cart opens
    presets: [],       // [{ name, disabled: string[], known: string[] }]
});

const state = {
    open: false,
    busy: false,
    checking: false,
    checkDone: 0,
    checkTotal: 0,
    items: [],
    cart: new Map(),      // extension name -> action
    progress: new Map(),  // extension name -> 'run' | 'ok' | 'fail'
    removed: new Set(),   // deleted during this page session (still listed by ST until reload)
    versions: {},         // extension name -> version info
    filter: 'all',
    showSystem: false,
    search: '',
    needsReload: false,
};

let root = null;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME] || typeof extensionSettings[MODULE_NAME] !== 'object') {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const settings = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(settings, key)) {
            settings[key] = structuredClone(defaultSettings[key]);
        }
    }
    if (!Array.isArray(settings.presets)) settings.presets = [];
    return settings;
}

function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));
}

/** Creates an element. `props.text` sets textContent, `props.cls` the class, others are attributes. */
function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'text') node.textContent = String(value);
        else if (key === 'cls') node.className = String(value);
        else if (key === 'onclick') node.addEventListener('click', value);
        else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of [].concat(children)) {
        if (child) node.append(child);
    }
    return node;
}

function icon(name) {
    return el('i', { cls: `fa-solid ${name} fa-fw`, 'aria-hidden': 'true' });
}

function timeAgo(timestamp) {
    if (!timestamp) return '없음';
    const minutes = Math.floor((Date.now() - timestamp) / 60000);
    if (minutes < 1) return '방금';
    if (minutes < 60) return `${minutes}분 전`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}시간 전`;
    return `${Math.floor(hours / 24)}일 전`;
}

/** Runs `worker` over `list` with at most `limit` running at once. */
async function runPool(list, limit, worker) {
    const queue = list.slice();
    const runners = [];
    for (let i = 0; i < Math.min(limit, queue.length); i++) {
        runners.push((async () => {
            while (queue.length > 0) {
                const entry = queue.shift();
                await worker(entry);
            }
        })());
    }
    await Promise.all(runners);
}

function loadCache() {
    try {
        const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
        state.versions = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        state.versions = {};
    }
}

function saveCache() {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(state.versions));
    } catch (error) {
        console.warn(LOG, 'Could not save the version cache', error);
    }
}

function loadView() {
    try {
        const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
        if (['all', 'update', 'on', 'off', 'cart'].includes(saved.filter)) state.filter = saved.filter;
        state.showSystem = Boolean(saved.showSystem);
    } catch { /* keep defaults */ }
}

function saveView() {
    try {
        localStorage.setItem(VIEW_KEY, JSON.stringify({ filter: state.filter, showSystem: state.showSystem }));
    } catch { /* not important */ }
}

function isStale(name) {
    const info = state.versions[name];
    if (!info || !info.at) return true;
    const ttl = Math.max(0, Number(getSettings().ttlHours) || 0) * 3600000;
    return Date.now() - info.at > ttl;
}

// ---------------------------------------------------------------------------
// Extension list
// ---------------------------------------------------------------------------

function buildItems() {
    const disabledList = Array.isArray(extension_settings.disabledExtensions) ? extension_settings.disabledExtensions : [];
    const admin = isAdmin();
    state.items = extensionNames
        .filter(name => !state.removed.has(name))
        .map(name => {
            const manifest = getExtensionManifest(name) || {};
            const thirdParty = name.startsWith(THIRD_PARTY);
            const folder = thirdParty ? name.slice(THIRD_PARTY.length) : name;
            const type = extensionTypes[name] || '';
            return {
                name,
                folder,
                manifest,
                type,
                thirdParty,
                title: String(manifest.display_name || folder),
                disabled: disabledList.includes(name),
                isSelf: name === SELF,
                // Global extensions can only be changed on disk by an admin (the server enforces this too)
                canManage: thirdParty && (type !== 'global' || admin),
            };
        })
        .sort((a, b) => a.title.localeCompare(b.title, 'ko'));
}

function findItem(name) {
    return state.items.find(item => item.name === name);
}

function hasUpdate(item) {
    const info = state.versions[item.name];
    return Boolean(info && !info.error && !info.noGit && info.isUpToDate === false);
}

/** Whether `action` makes sense for this extension right now. */
function can(item, action) {
    const info = state.versions[item.name];
    switch (action) {
        case 'update': return item.canManage && !(info && info.noGit);
        case 'enable': return item.disabled;
        case 'disable': return !item.disabled && !item.isSelf;
        case 'delete': return item.canManage;
        case 'reinstall': return item.canManage && !item.isSelf && Boolean(info && info.remoteUrl);
        default: return false;
    }
}

function whyNot(item, action) {
    const info = state.versions[item.name];
    if (!item.thirdParty && action !== 'enable' && action !== 'disable') return '기본 내장 확장은 켜고 끄기만 돼요';
    if (item.thirdParty && !item.canManage) return '전역 확장은 관리자만 바꿀 수 있어요';
    if (action === 'update' && info && info.noGit) return 'git으로 받은 확장이 아니라서 업데이트할 수 없어요';
    if (action === 'disable' && item.isSelf) return '장바구니 자신은 여기서 끌 수 없어요';
    if (action === 'reinstall' && item.isSelf) return '장바구니 자신은 다시 설치할 수 없어요';
    if (action === 'reinstall') return '원격 주소를 몰라요. 먼저 업데이트 확인을 해 주세요';
    return '';
}

function visibleItems() {
    const query = state.search.trim().toLowerCase();
    return state.items.filter(item => {
        if (!item.thirdParty && !state.showSystem) return false;
        if (query && !item.title.toLowerCase().includes(query) && !item.folder.toLowerCase().includes(query)) return false;
        switch (state.filter) {
            case 'update': return hasUpdate(item);
            case 'on': return !item.disabled;
            case 'off': return item.disabled;
            case 'cart': return state.cart.has(item.name);
            default: return true;
        }
    }).sort((a, b) => Number(hasUpdate(b)) - Number(hasUpdate(a))); // updates first; the sort is stable, so names stay in order
}

// ---------------------------------------------------------------------------
// Server calls
// ---------------------------------------------------------------------------

async function postJson(url, body) {
    return fetch(url, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
}

function serverBody(item, extra = {}) {
    return { extensionName: item.folder, global: item.type === 'global', ...extra };
}

async function failText(response) {
    let text = '';
    try { text = (await response.text()).trim(); } catch { /* ignore */ }
    if (response.status === 500) {
        return '서버 오류 — 자세한 이유는 실리태번 서버 창(검은 창)에 나와요';
    }
    return `${response.status} ${text || response.statusText}`.trim();
}

async function fetchVersion(item) {
    try {
        const response = await postJson('/api/extensions/version', serverBody(item));
        if (!response.ok) {
            state.versions[item.name] = { error: await failText(response), at: Date.now() };
            return;
        }
        const data = await response.json();
        state.versions[item.name] = {
            isUpToDate: data.isUpToDate !== false,
            remoteUrl: String(data.remoteUrl || ''),
            branch: String(data.currentBranchName || ''),
            commit: String(data.currentCommitHash || ''),
            noGit: !data.currentCommitHash && !data.remoteUrl,
            at: Date.now(),
        };
    } catch (error) {
        console.warn(LOG, 'Version check failed for', item.name, error);
        state.versions[item.name] = { error: '서버에 연결하지 못했어요', at: Date.now() };
    }
}

/** Checks for updates. `force` re-checks everything, otherwise only entries older than the remember time. */
async function checkVersions(force, onlyItems = null) {
    if (state.checking) return;
    const candidates = (onlyItems || state.items).filter(item => item.thirdParty && (force || isStale(item.name)));
    if (candidates.length === 0) return;
    state.checking = true;
    state.checkDone = 0;
    state.checkTotal = candidates.length;
    renderStatus();
    try {
        await runPool(candidates, CHECK_POOL_SIZE, async (item) => {
            await fetchVersion(item);
            state.checkDone++;
            saveCache();
            if (state.open) {
                updateRow(item.name);
                renderStatus();
            }
        });
    } finally {
        state.checking = false;
        if (state.open) {
            renderChips();
            renderStatus();
            renderList();
        }
    }
}

/**
 * Calls a lifecycle hook (update / delete) that an extension declares in its manifest.
 * Only for extensions that are currently enabled, so a disabled extension's code is never started by us.
 */
async function callHook(item, hookName) {
    try {
        const hooks = item.manifest && item.manifest.hooks;
        if (item.disabled || !hooks || typeof hooks !== 'object' || !Object.hasOwn(hooks, hookName)) return;
        const functionName = hooks[hookName];
        if (typeof functionName !== 'string' || !functionName || !item.manifest.js) return;
        const module = await import(`/scripts/extensions/${item.name}/${item.manifest.js}`);
        if (typeof module[functionName] !== 'function') return;
        await Promise.race([
            Promise.resolve(module[functionName]()),
            new Promise(resolve => setTimeout(resolve, HOOK_TIMEOUT)),
        ]);
    } catch (error) {
        console.warn(LOG, `Hook "${hookName}" failed for`, item.name, error);
    }
}

// Each do* function returns { status: 'ok' | 'same' | 'fail', detail: string }

async function doUpdate(item) {
    try {
        const response = await postJson('/api/extensions/update', serverBody(item));
        if (!response.ok) {
            return { status: 'fail', detail: await failText(response) };
        }
        const data = await response.json();
        const previous = state.versions[item.name] || {};
        state.versions[item.name] = { ...previous, isUpToDate: true, error: undefined, remoteUrl: String(data.remoteUrl || previous.remoteUrl || ''), at: Date.now() };
        if (data.isUpToDate) {
            return { status: 'same', detail: '이미 최신이에요' };
        }
        await callHook(item, 'update');
        return { status: 'ok', detail: `→ ${data.shortCommitHash || '새 버전'}` };
    } catch (error) {
        console.error(LOG, 'Update failed', item.name, error);
        return { status: 'fail', detail: '서버에 연결하지 못했어요' };
    }
}

async function doToggle(item, enable) {
    try {
        const disabledList = extension_settings.disabledExtensions;
        const isDisabled = disabledList.includes(item.name);
        if (enable && isDisabled) {
            await enableExtension(item.name, false);
        } else if (!enable && !isDisabled) {
            await disableExtension(item.name, false);
        } else {
            return { status: 'same', detail: enable ? '이미 켜져 있어요' : '이미 꺼져 있어요' };
        }
        return { status: 'ok', detail: '' };
    } catch (error) {
        console.error(LOG, 'Toggle failed', item.name, error);
        return { status: 'fail', detail: '설정을 저장하지 못했어요' };
    }
}

async function doDelete(item) {
    try {
        await callHook(item, 'delete');
        const response = await postJson('/api/extensions/delete', serverBody(item));
        if (!response.ok) {
            return { status: 'fail', detail: await failText(response) };
        }
        delete state.versions[item.name];
        state.removed.add(item.name);
        return { status: 'ok', detail: '' };
    } catch (error) {
        console.error(LOG, 'Delete failed', item.name, error);
        return { status: 'fail', detail: '서버에 연결하지 못했어요' };
    }
}

/** Delete the folder, then install again from the same address and branch. */
async function doReinstall(item) {
    const info = state.versions[item.name];
    if (!info || !info.remoteUrl) {
        return { status: 'fail', detail: '원격 주소를 몰라서 건너뛰었어요 (지워지지 않았어요)' };
    }
    const url = info.remoteUrl;
    try {
        const deleted = await postJson('/api/extensions/delete', serverBody(item));
        if (!deleted.ok) {
            return { status: 'fail', detail: `삭제 단계에서 실패: ${await failText(deleted)}` };
        }
    } catch (error) {
        console.error(LOG, 'Reinstall (delete step) failed', item.name, error);
        return { status: 'fail', detail: '삭제 단계에서 서버에 연결하지 못했어요' };
    }
    try {
        const installed = await postJson('/api/extensions/install', { url, global: item.type === 'global', branch: info.branch || '' });
        if (!installed.ok) {
            state.removed.add(item.name);
            delete state.versions[item.name];
            return { status: 'fail', critical: true, detail: `폴더는 지워졌는데 설치에 실패했어요. 확장 설치에 이 주소를 직접 넣어 주세요: ${url} (${await failText(installed)})` };
        }
        const data = await installed.json();
        state.versions[item.name] = { ...info, isUpToDate: true, at: Date.now() };
        const note = data.folderName && data.folderName !== item.folder ? `폴더 이름이 ${data.folderName} (으)로 바뀌었어요` : '';
        return { status: 'ok', detail: note };
    } catch (error) {
        console.error(LOG, 'Reinstall (install step) failed', item.name, error);
        state.removed.add(item.name);
        return { status: 'fail', critical: true, detail: `폴더는 지워졌는데 설치 요청이 끊겼어요. 확장 설치에 이 주소를 직접 넣어 주세요: ${url}` };
    }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/** Warnings about dependencies between extensions, based on what the cart will do. */
function collectWarnings() {
    const warnings = [];
    const finalOff = (item) => {
        const action = state.cart.get(item.name);
        if (action === 'delete') return true;
        if (action === 'disable') return true;
        if (action === 'enable') return false;
        return item.disabled;
    };
    for (const item of state.items) {
        const deps = Array.isArray(item.manifest.dependencies) ? item.manifest.dependencies : [];
        if (deps.length === 0 || finalOff(item)) continue;
        const beingEnabled = state.cart.get(item.name) === 'enable';
        for (const depName of deps) {
            const dep = findItem(depName);
            if (!dep) {
                if (beingEnabled) warnings.push(`「${item.title}」에 필요한 확장 ${depName} 이(가) 설치돼 있지 않아요.`);
                continue;
            }
            const depAction = state.cart.get(dep.name);
            const depTurnedOff = depAction === 'delete' || depAction === 'disable';
            if (depTurnedOff || (beingEnabled && finalOff(dep))) {
                warnings.push(`「${item.title}」은(는) 「${dep.title}」이(가) 켜져 있어야 해요.`);
            }
        }
    }
    return warnings;
}

function cartEntries() {
    return [...state.cart.entries()]
        .map(([name, action]) => ({ item: findItem(name), action }))
        .filter(entry => entry.item && can(entry.item, entry.action));
}

function cartSummary() {
    const counts = {};
    for (const { action } of cartEntries()) counts[action] = (counts[action] || 0) + 1;
    return Object.keys(ACTION_LABEL).filter(key => counts[key]).map(key => `${ACTION_LABEL[key]} ${counts[key]}`).join(' · ');
}

async function confirmApply(entries) {
    const risky = entries.filter(entry => ['delete', 'disable', 'reinstall'].includes(entry.action));
    const warnings = collectWarnings();
    if (risky.length === 0 && warnings.length === 0) return true;

    const { Popup, POPUP_RESULT } = SillyTavern.getContext();
    const parts = [];
    for (const action of ['delete', 'reinstall', 'disable']) {
        const names = risky.filter(entry => entry.action === action).map(entry => esc(entry.item.title));
        if (names.length > 0) {
            parts.push(`<p style="text-align:left"><b>${ACTION_LABEL[action]} ${names.length}개</b><br>${names.join(', ')}</p>`);
        }
    }
    if (risky.some(entry => entry.action === 'delete')) {
        parts.push('<p style="text-align:left">삭제한 확장은 되돌릴 수 없어요.</p>');
    }
    if (risky.some(entry => entry.action === 'reinstall')) {
        parts.push('<p style="text-align:left">다시 설치는 폴더를 지우고 새로 받아요. 폴더 안에 따로 저장된 파일은 사라지고, 설치가 실패하면 확장이 지워진 채로 남아요.</p>');
    }
    if (warnings.length > 0) {
        parts.push(`<p style="text-align:left"><b>주의</b><br>${warnings.map(esc).join('<br>')}</p>`);
    }
    const result = await Popup.show.confirm('이대로 적용할까요?', parts.join(''));
    return result === POPUP_RESULT.AFFIRMATIVE;
}

function blockUnload(event) {
    event.preventDefault();
    event.returnValue = '';
}

async function applyCart() {
    if (state.busy) return;
    const entries = cartEntries();
    if (entries.length === 0) {
        toastr.info('담은 것이 없어요.', '확장 장바구니');
        return;
    }
    if (!(await confirmApply(entries))) return;

    state.busy = true;
    state.progress.clear();
    root.classList.add('extcart-busy');
    window.addEventListener('beforeunload', blockUnload);

    const results = [];
    let done = 0;
    const total = entries.length;
    const foot = root.querySelector('.extcart-foot-text');

    const run = async (entry, worker) => {
        state.progress.set(entry.item.name, 'run');
        updateRow(entry.item.name);
        foot.textContent = `진행 중 ${done + 1}/${total} · ${entry.item.title} ${ACTION_LABEL[entry.action]}`;
        let result;
        try {
            result = await worker(entry.item);
        } catch (error) {
            console.error(LOG, 'Unexpected error', entry, error);
            result = { status: 'fail', detail: '알 수 없는 오류 (F12 콘솔 확인)' };
        }
        done++;
        results.push({ ...entry, ...result });
        state.progress.set(entry.item.name, result.status === 'fail' ? 'fail' : 'ok');
        updateRow(entry.item.name);
    };

    try {
        const others = entries.filter(entry => !entry.item.isSelf);
        const mine = entries.filter(entry => entry.item.isSelf);

        // 1) updates, a few at a time
        await runPool(others.filter(entry => entry.action === 'update'), POOL_SIZE, entry => run(entry, doUpdate));
        // 2) enable / disable, one by one (each call saves settings)
        for (const entry of others.filter(e => e.action === 'enable')) await run(entry, item => doToggle(item, true));
        for (const entry of others.filter(e => e.action === 'disable')) await run(entry, item => doToggle(item, false));
        // 3) reinstall, then delete
        for (const entry of others.filter(e => e.action === 'reinstall')) await run(entry, doReinstall);
        for (const entry of others.filter(e => e.action === 'delete')) await run(entry, doDelete);
        // 4) this extension itself goes last
        for (const entry of mine) {
            if (entry.action === 'update') await run(entry, doUpdate);
            else if (entry.action === 'enable') await run(entry, item => doToggle(item, true));
            else if (entry.action === 'delete') await run(entry, doDelete);
        }

        saveCache();
        foot.textContent = '설정 저장 중…';
        try {
            await saveSettings();
        } catch (error) {
            console.error(LOG, 'saveSettings failed', error);
        }
    } finally {
        window.removeEventListener('beforeunload', blockUnload);
        state.busy = false;
        root.classList.remove('extcart-busy');
    }

    state.cart.clear();
    state.progress.clear();
    if (results.some(result => result.status === 'ok')) state.needsReload = true;
    buildItems();
    renderAll();
    showResult(results);
}

// ---------------------------------------------------------------------------
// UI: main panel
// ---------------------------------------------------------------------------

function createRoot() {
    if (root) return;
    root = el('div', { id: 'extcart_root', cls: 'extcart-overlay', 'data-bl-native-ext-colors': true, role: 'dialog', 'aria-label': '확장 장바구니' });
    root.hidden = true;

    const head = el('div', { cls: 'extcart-head' }, [
        el('div', { cls: 'extcart-title', text: '확장 장바구니' }),
        el('button', { cls: 'extcart-btn', type: 'button', title: '켜기/끄기 묶음', onclick: () => showPresets() }, [icon('fa-layer-group'), el('span', { text: '묶음' })]),
        el('button', { cls: 'extcart-btn extcart-icononly', type: 'button', title: '설정', 'aria-label': '설정', onclick: () => showSettings() }, [icon('fa-gear')]),
        el('button', { cls: 'extcart-btn extcart-icononly', type: 'button', title: '닫기', 'aria-label': '닫기', onclick: () => closeCart() }, [icon('fa-xmark')]),
    ]);

    const search = el('input', { cls: 'text_pole extcart-search', type: 'search', placeholder: '확장 이름 검색', 'aria-label': '확장 이름 검색' });
    search.addEventListener('input', () => {
        state.search = search.value;
        renderList();
    });

    const tools = el('div', { cls: 'extcart-tools' }, [
        search,
        el('div', { cls: 'extcart-chips' }),
        el('div', { cls: 'extcart-bulk' }, [
            el('button', { cls: 'extcart-btn', type: 'button', onclick: () => addUpdates(false) }, [icon('fa-arrow-up'), el('span', { text: '업데이트 있는 것 담기' })]),
            el('button', { cls: 'extcart-btn', type: 'button', onclick: () => addUpdates(true) }, [el('span', { text: '전체 업데이트 담기' })]),
            el('button', { cls: 'extcart-btn', type: 'button', onclick: () => { state.cart.clear(); renderAll(); } }, [el('span', { text: '비우기' })]),
        ]),
        el('div', { cls: 'extcart-status-row' }, [
            el('div', { cls: 'extcart-status' }),
            el('button', { cls: 'extcart-btn extcart-small', type: 'button', title: '업데이트 지금 다시 확인', onclick: () => checkVersions(true) }, [icon('fa-rotate'), el('span', { text: '다시 확인' })]),
        ]),
    ]);

    const panel = el('div', { cls: 'extcart-panel' }, [
        head,
        el('div', { cls: 'extcart-reload-banner' }),
        tools,
        el('div', { cls: 'extcart-list' }),
        el('div', { cls: 'extcart-foot' }, [
            el('div', { cls: 'extcart-foot-text' }),
            el('button', { cls: 'extcart-btn extcart-primary extcart-apply', type: 'button', onclick: () => applyCart() }, [el('span', { text: '적용' })]),
        ]),
        el('div', { cls: 'extcart-sheet-wrap' }),
    ]);
    panel.querySelector('.extcart-sheet-wrap').hidden = true;

    root.append(panel);
    // Tap on the dimmed background closes the cart
    root.addEventListener('click', (event) => {
        if (event.target === root) closeCart();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !state.open || state.busy) return;
        // Leave Escape to ST popups (confirm / input) when one is open on top of the cart
        if (document.querySelector('dialog[open]')) return;
        if (!closeSheet()) closeCart();
    });
    document.body.append(root);
}

function openCart() {
    createRoot();
    loadCache();
    buildItems();
    // Forget remembered results of extensions that are no longer installed
    const installed = new Set(state.items.map(item => item.name));
    for (const name of Object.keys(state.versions)) {
        if (!installed.has(name)) delete state.versions[name];
    }
    state.open = true;
    root.hidden = false;
    renderAll();
    if (getSettings().autoCheck) {
        void checkVersions(false);
    }
}

function closeCart() {
    if (!root || state.busy) return;
    closeSheet();
    state.open = false;
    root.hidden = true;
}

function renderAll() {
    renderBanner();
    renderChips();
    renderStatus();
    renderList();
    renderFoot();
}

function renderBanner() {
    const banner = root.querySelector('.extcart-reload-banner');
    banner.replaceChildren();
    banner.hidden = !state.needsReload;
    if (!state.needsReload) return;
    banner.append(
        el('span', { text: '바뀐 내용은 새로고침해야 반영돼요.' }),
        el('button', { cls: 'extcart-btn extcart-primary', type: 'button', onclick: () => location.reload() }, [el('span', { text: '새로고침' })]),
    );
}

function renderChips() {
    const box = root.querySelector('.extcart-chips');
    const base = state.items.filter(item => item.thirdParty || state.showSystem);
    const chips = [
        ['all', '전체', base.length],
        ['update', '업데이트 있음', base.filter(hasUpdate).length],
        ['on', '켜짐', base.filter(item => !item.disabled).length],
        ['off', '꺼짐', base.filter(item => item.disabled).length],
        ['cart', '담은 것', base.filter(item => state.cart.has(item.name)).length],
    ];
    box.replaceChildren();
    for (const [key, label, count] of chips) {
        box.append(el('button', {
            cls: `extcart-chip${state.filter === key ? ' extcart-on' : ''}`,
            type: 'button',
            'aria-pressed': state.filter === key ? 'true' : 'false',
            text: `${label} ${count}`,
            onclick: () => { state.filter = key; saveView(); renderChips(); renderList(); },
        }));
    }
    box.append(el('button', {
        cls: `extcart-chip extcart-chip-alt${state.showSystem ? ' extcart-on' : ''}`,
        type: 'button',
        'aria-pressed': state.showSystem ? 'true' : 'false',
        text: '기본 내장도 보기',
        onclick: () => { state.showSystem = !state.showSystem; saveView(); renderChips(); renderList(); },
    }));
}

function renderStatus() {
    if (!root) return;
    const box = root.querySelector('.extcart-status');
    if (state.checking) {
        box.textContent = `업데이트 확인 중 ${state.checkDone}/${state.checkTotal}…`;
        return;
    }
    const times = state.items.filter(item => item.thirdParty).map(item => state.versions[item.name]?.at).filter(Boolean);
    box.textContent = times.length > 0 ? `마지막 업데이트 확인: ${timeAgo(Math.min(...times))}` : '아직 업데이트 확인을 안 했어요. 「다시 확인」을 눌러 주세요.';
}

function renderFoot() {
    const summary = cartSummary();
    root.querySelector('.extcart-foot-text').textContent = summary || '확장 옆 단추를 눌러 할 일을 담아 주세요.';
    root.querySelector('.extcart-apply').disabled = !summary;
}

function renderList() {
    const list = root.querySelector('.extcart-list');
    const items = visibleItems();
    list.replaceChildren();
    if (items.length === 0) {
        list.append(el('div', { cls: 'extcart-empty', text: '여기에 해당하는 확장이 없어요.' }));
        return;
    }
    for (const item of items) list.append(buildRow(item));
}

function updateRow(name) {
    if (!root) return;
    const item = findItem(name);
    const old = [...root.querySelectorAll('.extcart-row')].find(row => row.dataset.name === name);
    if (old && item) old.replaceWith(buildRow(item));
}

function actionButton(item, action, iconName, label) {
    const allowed = can(item, action);
    const selected = state.cart.get(item.name) === action;
    return el('button', {
        cls: `extcart-act extcart-act-${action}${selected ? ' extcart-on' : ''}${action === 'update' && allowed && hasUpdate(item) ? ' extcart-has-update' : ''}`,
        type: 'button',
        title: allowed ? label : (whyNot(item, action) || label),
        'aria-label': `${item.title} ${label}`,
        'aria-pressed': selected ? 'true' : 'false',
        disabled: !allowed,
        onclick: () => pick(item.name, action),
    }, [icon(iconName)]);
}

function buildRow(item) {
    const info = state.versions[item.name];
    const action = state.cart.get(item.name);
    const progress = state.progress.get(item.name);

    const meta = el('div', { cls: 'extcart-meta' });
    if (item.manifest.version) meta.append(el('span', { text: `v${item.manifest.version}` }));
    if (item.disabled) meta.append(el('span', { cls: 'extcart-tag extcart-tag-off', text: '꺼짐' }));
    if (hasUpdate(item)) meta.append(el('span', { cls: 'extcart-tag extcart-tag-up' }, [icon('fa-circle-up'), el('span', { text: '업데이트 있음' })]));
    if (info && info.noGit && item.thirdParty) meta.append(el('span', { cls: 'extcart-tag', text: 'git 아님' }));
    if (info && info.error) meta.append(el('span', { cls: 'extcart-tag extcart-tag-fail', text: '확인 실패' }));
    if (item.type === 'global') meta.append(el('span', { cls: 'extcart-tag', text: '전역' }));
    if (!item.thirdParty) meta.append(el('span', { cls: 'extcart-tag', text: '내장' }));
    if (item.isSelf) meta.append(el('span', { cls: 'extcart-tag', text: '이 확장' }));
    if (progress === 'run') meta.append(el('span', { cls: 'extcart-tag extcart-tag-run', text: '진행 중…' }));
    else if (progress === 'ok') meta.append(el('span', { cls: 'extcart-tag extcart-tag-ok', text: '완료' }));
    else if (progress === 'fail') meta.append(el('span', { cls: 'extcart-tag extcart-tag-fail', text: '실패' }));
    else if (action) meta.append(el('span', { cls: `extcart-tag extcart-tag-pick extcart-pick-${action}`, text: `담음: ${ACTION_LABEL[action]}` }));

    const toggleAction = item.disabled ? 'enable' : 'disable';
    const acts = el('div', { cls: 'extcart-acts' }, [
        actionButton(item, 'update', 'fa-arrow-up', '업데이트'),
        actionButton(item, toggleAction, 'fa-power-off', item.disabled ? '켜기' : '끄기'),
        actionButton(item, 'delete', 'fa-trash-can', '삭제'),
        el('button', { cls: `extcart-act extcart-act-more${action === 'reinstall' ? ' extcart-on' : ''}`, type: 'button', title: '자세히 / 다시 설치', 'aria-label': `${item.title} 자세히`, onclick: () => showDetails(item.name) }, [icon('fa-ellipsis')]),
    ]);

    const row = el('div', { cls: `extcart-row${hasUpdate(item) ? ' extcart-row-update' : ''}${action ? ' extcart-picked' : ''}${item.disabled ? ' extcart-row-off' : ''}` }, [
        el('div', { cls: 'extcart-info' }, [el('div', { cls: 'extcart-name', text: item.title, title: item.folder }), meta]),
        acts,
    ]);
    row.dataset.name = item.name;
    return row;
}

/** Put an action in the cart, or take it out when the same one is tapped again. */
function pick(name, action) {
    if (state.busy) return;
    const item = findItem(name);
    if (!item || !can(item, action)) return;
    if (state.cart.get(name) === action) state.cart.delete(name);
    else state.cart.set(name, action);
    updateRow(name);
    renderChips();
    renderFoot();
    if (state.filter === 'cart') renderList();
}

function addUpdates(all) {
    if (state.busy) return;
    let added = 0;
    for (const item of state.items) {
        if (!item.thirdParty || !can(item, 'update') || state.cart.has(item.name)) continue;
        if (!all && !hasUpdate(item)) continue;
        state.cart.set(item.name, 'update');
        added++;
    }
    renderAll();
    if (added === 0) {
        toastr.info(all ? '더 담을 확장이 없어요.' : '업데이트가 있는 확장이 없어요. 「다시 확인」을 눌러 볼 수 있어요.', '확장 장바구니');
    }
}

// ---------------------------------------------------------------------------
// UI: sheets (details, presets, result)
// ---------------------------------------------------------------------------

function openSheet(title, body, { closable = true } = {}) {
    const wrap = root.querySelector('.extcart-sheet-wrap');
    const closeButton = closable
        ? el('button', { cls: 'extcart-btn extcart-icononly', type: 'button', title: '닫기', 'aria-label': '닫기', onclick: () => closeSheet() }, [icon('fa-xmark')])
        : null;
    const sheet = el('div', { cls: 'extcart-sheet' }, [
        el('div', { cls: 'extcart-head' }, [el('div', { cls: 'extcart-title', text: title }), closeButton]),
        el('div', { cls: 'extcart-sheet-body' }, body),
    ]);
    wrap.replaceChildren(sheet);
    wrap.dataset.closable = closable ? '1' : '0';
    wrap.hidden = false;
    wrap.onclick = (event) => {
        if (event.target === wrap && closable) closeSheet();
    };
}

/** Closes the open sheet. Returns true when there was one to close. */
function closeSheet() {
    if (!root) return false;
    const wrap = root.querySelector('.extcart-sheet-wrap');
    if (wrap.hidden) return false;
    if (wrap.dataset.closable === '0') return true;
    wrap.hidden = true;
    wrap.replaceChildren();
    return true;
}

function infoLine(label, value) {
    return el('div', { cls: 'extcart-kv' }, [el('span', { cls: 'extcart-k', text: label }), el('span', { cls: 'extcart-v' }, [value])]);
}

function showDetails(name) {
    const item = findItem(name);
    if (!item) return;
    const info = state.versions[item.name] || {};
    const body = [];

    body.push(infoLine('폴더', item.folder));
    if (item.manifest.version) body.push(infoLine('버전', `v${item.manifest.version}`));
    if (item.manifest.author) body.push(infoLine('만든 이', String(item.manifest.author)));
    body.push(infoLine('상태', item.disabled ? '꺼짐' : '켜짐'));
    if (info.branch) body.push(infoLine('브랜치', `${info.branch}${info.commit ? ` · ${info.commit.slice(0, 7)}` : ''}`));
    if (info.remoteUrl && /^https?:\/\//i.test(info.remoteUrl)) {
        body.push(infoLine('원격 주소', el('a', { href: info.remoteUrl, target: '_blank', rel: 'noopener noreferrer', text: info.remoteUrl })));
    } else if (info.remoteUrl) {
        body.push(infoLine('원격 주소', info.remoteUrl));
    }
    if (item.thirdParty) {
        const checkText = info.error ? `실패 — ${info.error}` : info.at ? `${timeAgo(info.at)} · ${info.noGit ? 'git 아님' : info.isUpToDate ? '최신' : '업데이트 있음'}` : '아직 안 함';
        body.push(infoLine('업데이트 확인', checkText));
    }
    const deps = Array.isArray(item.manifest.dependencies) ? item.manifest.dependencies : [];
    if (deps.length > 0) body.push(infoLine('필요한 확장', deps.join(', ')));

    const buttons = el('div', { cls: 'extcart-sheet-actions' });
    const toggleAction = item.disabled ? 'enable' : 'disable';
    const options = [
        ['update', 'fa-arrow-up', '업데이트'],
        [toggleAction, 'fa-power-off', item.disabled ? '켜기' : '끄기'],
        ['reinstall', 'fa-rotate-right', '다시 설치 (지우고 새로 받기)'],
        ['delete', 'fa-trash-can', '삭제'],
    ];
    for (const [action, iconName, label] of options) {
        const allowed = can(item, action);
        const selected = state.cart.get(item.name) === action;
        const button = el('button', {
            cls: `extcart-btn extcart-wide${selected ? ' extcart-primary' : ''}`,
            type: 'button',
            disabled: !allowed,
            'aria-pressed': selected ? 'true' : 'false',
            onclick: () => { pick(item.name, action); closeSheet(); },
        }, [icon(iconName), el('span', { text: selected ? `${label} — 담음 (다시 누르면 빼기)` : label })]);
        buttons.append(button);
        if (!allowed) {
            const reason = whyNot(item, action);
            if (reason) buttons.append(el('div', { cls: 'extcart-hint', text: reason }));
        }
    }
    if (item.thirdParty) {
        buttons.append(el('button', {
            cls: 'extcart-btn extcart-wide',
            type: 'button',
            onclick: async () => {
                closeSheet();
                if (state.checking) {
                    toastr.info('지금 하는 확인이 끝난 뒤에 다시 눌러 주세요.', '확장 장바구니');
                    return;
                }
                await checkVersions(true, [item]);
                if (state.open) showDetails(item.name);
            },
        }, [icon('fa-rotate'), el('span', { text: '이 확장만 업데이트 확인' })]));
    }
    body.push(buttons);
    openSheet(item.title, body);
}

async function persistSettings() {
    try {
        await saveSettings();
    } catch (error) {
        console.error(LOG, 'saveSettings failed', error);
        toastr.error('설정을 저장하지 못했어요.', '확장 장바구니');
    }
}

function showPresets() {
    if (state.busy) return;
    const settings = getSettings();
    const { Popup, POPUP_RESULT } = SillyTavern.getContext();
    const body = [];

    body.push(el('div', { cls: 'extcart-hint', text: '묶음은 어떤 확장이 켜져 있고 꺼져 있는지를 기억해요. 불러오면 달라지는 것만 장바구니에 담기고, 「적용」을 눌러야 바뀌어요.' }));

    const snapshot = () => {
        const known = state.items.map(item => item.name);
        const disabled = state.items.filter(item => item.disabled).map(item => item.name);
        return { known, disabled };
    };

    body.push(el('button', {
        cls: 'extcart-btn extcart-wide extcart-primary',
        type: 'button',
        onclick: async () => {
            const name = await Popup.show.input('새 묶음', '지금 켜짐·꺼짐 상태를 저장해요. 이름을 적어 주세요.', '');
            const trimmed = typeof name === 'string' ? name.trim() : '';
            if (!trimmed) return;
            settings.presets.push({ name: trimmed, ...snapshot() });
            await persistSettings();
            showPresets();
        },
    }, [icon('fa-plus'), el('span', { text: '지금 상태를 새 묶음으로 저장' })]));

    if (settings.presets.length === 0) {
        body.push(el('div', { cls: 'extcart-empty', text: '저장한 묶음이 아직 없어요.' }));
    }

    settings.presets.forEach((preset, index) => {
        const offCount = (preset.disabled || []).length;
        const line = el('div', { cls: 'extcart-preset' }, [
            el('div', { cls: 'extcart-info' }, [
                el('div', { cls: 'extcart-name', text: preset.name }),
                el('div', { cls: 'extcart-meta', text: `꺼짐 ${offCount}개 · 기억한 확장 ${(preset.known || []).length}개` }),
            ]),
            el('button', { cls: 'extcart-btn extcart-primary', type: 'button', onclick: () => loadPreset(preset) }, [el('span', { text: '불러오기' })]),
            el('button', {
                cls: 'extcart-btn', type: 'button', title: '지금 상태로 덮어쓰기',
                onclick: async () => {
                    const ok = await Popup.show.confirm('묶음 덮어쓰기', `「${esc(preset.name)}」을(를) 지금 상태로 바꿀까요?`);
                    if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
                    Object.assign(preset, snapshot());
                    await persistSettings();
                    showPresets();
                },
            }, [icon('fa-floppy-disk')]),
            el('button', {
                cls: 'extcart-btn', type: 'button', title: '묶음 지우기',
                onclick: async () => {
                    const ok = await Popup.show.confirm('묶음 지우기', `「${esc(preset.name)}」을(를) 지울까요? 확장은 지워지지 않아요.`);
                    if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
                    settings.presets.splice(index, 1);
                    await persistSettings();
                    showPresets();
                },
            }, [icon('fa-trash-can')]),
        ]);
        body.push(line);
    });

    openSheet('켜기/끄기 묶음', body);
}

/** Fill the cart with the enable/disable actions needed to reach the preset's state. */
function loadPreset(preset) {
    const known = new Set(preset.known || []);
    const wantOff = new Set(preset.disabled || []);
    let count = 0;
    for (const item of state.items) {
        if (!known.has(item.name) || item.isSelf) continue;
        const current = state.cart.get(item.name);
        // Keep update / delete / reinstall choices the user already made
        if (current && current !== 'enable' && current !== 'disable') continue;
        const shouldBeOff = wantOff.has(item.name);
        if (shouldBeOff === item.disabled) {
            state.cart.delete(item.name);
        } else {
            state.cart.set(item.name, shouldBeOff ? 'disable' : 'enable');
            count++;
        }
    }
    closeSheet();
    state.filter = count > 0 ? 'cart' : state.filter;
    state.showSystem = state.showSystem || [...state.cart.keys()].some(name => !name.startsWith(THIRD_PARTY));
    renderAll();
    if (count > 0) toastr.info(`켜기·끄기 ${count}개를 담았어요. 확인하고 「적용」을 눌러 주세요.`, preset.name);
    else toastr.info('지금 상태가 이 묶음과 같아요.', preset.name);
}

function showResult(results) {
    const settings = getSettings();
    const okCount = (action) => results.filter(r => r.action === action && r.status !== 'fail').length;
    const failed = results.filter(r => r.status === 'fail');
    const changed = results.some(r => r.status === 'ok');

    const summary = Object.keys(ACTION_LABEL)
        .filter(action => results.some(r => r.action === action))
        .map(action => `${ACTION_LABEL[action]} ${okCount(action)}`)
        .join(' · ');

    const body = [el('div', { cls: 'extcart-result-sum', text: `${summary || '한 일이 없어요'}${failed.length > 0 ? ` · 실패 ${failed.length}` : ''}` })];

    if (failed.length > 0) {
        const box = el('div', { cls: 'extcart-result-list extcart-result-fail' }, [el('div', { cls: 'extcart-result-head', text: '실패한 것' })]);
        for (const r of failed) {
            box.append(el('div', { cls: 'extcart-result-line' }, [
                el('b', { text: `${r.item.title} (${ACTION_LABEL[r.action]})` }),
                el('div', { text: r.detail || '이유를 알 수 없어요' }),
            ]));
        }
        if (failed.some(r => r.action === 'update')) {
            box.append(el('div', { cls: 'extcart-hint', text: '업데이트가 계속 실패하는 확장은 ⋯ 단추의 「다시 설치」를 써 볼 수 있어요.' }));
        }
        body.push(box);
    }

    const fine = results.filter(r => r.status !== 'fail');
    if (fine.length > 0) {
        const box = el('div', { cls: 'extcart-result-list' }, [el('div', { cls: 'extcart-result-head', text: '된 것' })]);
        for (const r of fine) {
            box.append(el('div', { cls: 'extcart-result-line', text: `${r.item.title} — ${ACTION_LABEL[r.action]}${r.detail ? ` (${r.detail})` : ''}` }));
        }
        body.push(box);
    }

    const actions = el('div', { cls: 'extcart-sheet-actions' });
    let timer = null;
    const closeButton = el('button', {
        cls: 'extcart-btn extcart-wide', type: 'button',
        onclick: () => {
            if (timer) clearInterval(timer);
            const wrap = root.querySelector('.extcart-sheet-wrap');
            wrap.dataset.closable = '1';
            closeSheet();
        },
    }, [el('span', { text: changed ? '나중에 새로고침' : '닫기' })]);

    if (changed) {
        const label = el('span', { text: '새로고침' });
        actions.append(el('button', { cls: 'extcart-btn extcart-wide extcart-primary', type: 'button', onclick: () => location.reload() }, [icon('fa-rotate-right'), label]));
        if (settings.autoReload && failed.length === 0) {
            let left = 3;
            label.textContent = `새로고침 (${left}초 뒤 자동)`;
            timer = setInterval(() => {
                left--;
                if (left <= 0) {
                    clearInterval(timer);
                    location.reload();
                } else {
                    label.textContent = `새로고침 (${left}초 뒤 자동)`;
                }
            }, 1000);
        }
    } else {
        body.push(el('div', { cls: 'extcart-hint', text: '바뀐 것이 없어서 새로고침은 필요 없어요.' }));
    }
    actions.append(closeButton);
    body.push(actions);

    openSheet('적용 결과', body, { closable: false });
}

// ---------------------------------------------------------------------------
// Entry points: settings drawer, wand menu, slash command
// ---------------------------------------------------------------------------

/** Settings live inside the cart (gear button), not in the Extensions panel. */
function showSettings() {
    if (state.busy) return;
    const settings = getSettings();
    const { saveSettingsDebounced } = SillyTavern.getContext();

    const autoReload = el('input', { type: 'checkbox', id: 'extcart_auto_reload' });
    autoReload.checked = Boolean(settings.autoReload);
    autoReload.addEventListener('change', () => { settings.autoReload = autoReload.checked; saveSettingsDebounced(); });

    const autoCheck = el('input', { type: 'checkbox', id: 'extcart_auto_check' });
    autoCheck.checked = Boolean(settings.autoCheck);
    autoCheck.addEventListener('change', () => { settings.autoCheck = autoCheck.checked; saveSettingsDebounced(); });

    const ttl = el('input', { type: 'number', id: 'extcart_ttl', cls: 'text_pole extcart-number', min: '0', max: '720', step: '1', inputmode: 'numeric' });
    ttl.value = String(settings.ttlHours);
    ttl.addEventListener('change', () => {
        const value = Math.min(720, Math.max(0, Number(ttl.value) || 0));
        settings.ttlHours = value;
        ttl.value = String(value);
        saveSettingsDebounced();
    });

    openSheet('설정', [
        el('label', { cls: 'extcart-setting', for: 'extcart_auto_reload' }, [autoReload, el('span', { text: '적용 후 자동 새로고침 (실패가 없을 때 3초 뒤)' })]),
        el('label', { cls: 'extcart-setting', for: 'extcart_auto_check' }, [autoCheck, el('span', { text: '열 때 오래된 업데이트 확인을 자동으로 다시 하기' })]),
        el('label', { cls: 'extcart-setting', for: 'extcart_ttl' }, [el('span', { text: '업데이트 확인 결과 기억 시간 (시간)' }), ttl]),
        el('div', { cls: 'extcart-hint', text: '0으로 두면 열 때마다 전부 다시 확인해요. 바꾼 값은 바로 저장돼요.' }),
        el('div', { cls: 'extcart-hint', text: '여는 곳: 입력창 왼쪽 햄버거(≡) 메뉴 맨 아래, 또는 슬래시 명령 /extcart' }),
    ]);
}

/** Adds the opener to the hamburger (options) menu at the left of the input bar. */
function addOptionsItem() {
    const menu = document.querySelector('#options .options-content');
    if (!menu || document.getElementById('extcart_option')) return;
    const entry = el('a', { id: 'extcart_option', cls: 'interactable', tabindex: '0', role: 'button' }, [
        el('i', { cls: 'fa-lg fa-solid fa-cart-shopping' }),
        el('span', { text: '확장 장바구니' }),
    ]);
    entry.addEventListener('click', () => {
        // Close the menu the same way a tap on the hamburger button does, so ST's own open/closed state stays right
        const options = document.getElementById('options');
        const button = document.getElementById('options_button');
        if (options && button && getComputedStyle(options).display !== 'none') button.click();
        openCart();
    });
    menu.append(el('hr'), entry);
}

function addSlashCommand() {
    try {
        const { SlashCommandParser, SlashCommand } = SillyTavern.getContext();
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'extcart',
            callback: () => {
                openCart();
                return '';
            },
            helpString: '<div>확장 장바구니를 열어요. 확장을 골라 한 번에 업데이트·켜기·끄기·삭제할 수 있어요.</div>',
        }));
    } catch (error) {
        console.warn(LOG, 'Could not register /extcart', error);
    }
}

(function init() {
    const { eventSource, event_types } = SillyTavern.getContext();
    getSettings();
    loadView();
    addSlashCommand();
    // APP_READY also fires for listeners attached after the app is already ready
    eventSource.on(event_types.APP_READY, () => {
        try {
            addOptionsItem();
        } catch (error) {
            console.error(LOG, 'UI setup failed', error);
        }
    });
    console.log(LOG, 'Loaded as', SELF);
})();
