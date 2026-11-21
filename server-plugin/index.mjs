/*
 * Extension Cart — optional server plugin
 *
 * The browser extension works without this. When this plugin is loaded, the cart gets:
 *   - faster update checks (one git fetch per extension)
 *   - the real reason when an update fails
 *   - forced update (reset to the remote branch), with a safety copy of locally edited folders
 *   - "go back to the previous version" after an update
 *   - folder delete that also works on Windows (read-only .git files)
 *
 * It only touches folders directly inside the extensions folders, only runs the `git` program
 * that is already installed, and never contacts anything except the extension's own git remote.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const info = {
    id: 'ext-cart',
    name: 'Extension Cart Server',
    description: 'Optional helper for the Extension Cart: forced update, rollback, clear error reasons, faster update checks.',
};

const VERSION = '1.0.0';
const GLOBAL_EXTENSIONS = 'public/scripts/extensions/third-party';
const PREV_REF = 'refs/extcart/prev'; // remembers the commit an extension was on before the last update
const GIT_TIMEOUT = 180000;
const BACKUPS_TO_KEEP = 2;

let gitAvailable = false;

/** Removes credentials from URLs and keeps the message short enough to show on screen. */
function cleanMessage(text) {
    return String(text || '')
        .replace(/\/\/[^/@\s]+@/g, '//')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('hint:'))
        .slice(-3)
        .join(' / ')
        .slice(0, 400);
}

/**
 * Runs git inside one extension folder.
 * GIT_CEILING_DIRECTORIES keeps git from ever climbing up into a parent repository (SillyTavern itself).
 */
function git(cwd, args) {
    return new Promise((resolve, reject) => {
        execFile('git', args, {
            cwd,
            timeout: GIT_TIMEOUT,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0', // never wait for a password prompt
                GIT_CEILING_DIRECTORIES: path.dirname(cwd),
                LC_ALL: 'C',
            },
        }, (error, stdout, stderr) => {
            if (error) {
                const timedOut = error.killed ? 'git did not answer in time. ' : '';
                reject(new Error(timedOut + cleanMessage(stderr || error.message)));
            } else {
                resolve(String(stdout).trim());
            }
        });
    });
}

async function gitOrNull(cwd, args) {
    try {
        return await git(cwd, args);
    } catch {
        return null;
    }
}

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/** Turns the request body into a checked folder path. Throws HttpError when anything is off. */
function resolveExtension(request) {
    const { extensionName, global: isGlobal } = request.body || {};
    if (typeof extensionName !== 'string' || !extensionName.trim()) {
        throw new HttpError(400, 'extensionName is required.');
    }
    const name = extensionName.trim();
    if (name.startsWith('.') || /[\\/:*?"<>|]/.test(name) || name.includes('..')) {
        throw new HttpError(400, 'Invalid extension name.');
    }
    if (isGlobal && !request.user?.profile?.admin) {
        throw new HttpError(403, 'Only an admin can change global extensions.');
    }
    const base = path.resolve(isGlobal ? path.join(process.cwd(), GLOBAL_EXTENSIONS) : request.user.directories.extensions);
    const dir = path.resolve(base, name);
    if (path.dirname(dir) !== base) {
        throw new HttpError(400, 'Invalid extension name.');
    }
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        throw new HttpError(404, 'Extension folder not found.');
    }
    return { name, dir, isRepo: fs.existsSync(path.join(dir, '.git')) };
}

function requireRepo(ext) {
    if (!gitAvailable) throw new HttpError(500, 'git is not installed on the server.');
    if (!ext.isRepo) throw new HttpError(400, 'This extension was not installed with git, so it cannot be updated.');
}

async function currentBranch(dir) {
    const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch || branch === 'HEAD') {
        throw new HttpError(400, 'The extension is not on a branch (detached HEAD).');
    }
    return branch;
}

async function isDirty(dir) {
    const status = await gitOrNull(dir, ['status', '--porcelain', '--untracked-files=no']);
    return Boolean(status);
}

/** Copies the whole extension folder into the user's backups folder and keeps only the newest few. */
async function backupFolder(request, ext) {
    const root = path.join(request.user.directories.backups, 'ext-cart');
    await fs.promises.mkdir(root, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    const target = path.join(root, `${ext.name}@${stamp}`);
    await fs.promises.cp(ext.dir, target, { recursive: true });

    const prefix = `${ext.name}@`;
    const old = (await fs.promises.readdir(root)).filter(entry => entry.startsWith(prefix)).sort().reverse().slice(BACKUPS_TO_KEEP);
    for (const entry of old) {
        await removeFolder(path.join(root, entry)).catch(() => { });
    }
    return target;
}

/** Windows refuses to delete read-only files (git objects are read-only), so make everything writable first. */
async function makeWritable(target) {
    let stat;
    try {
        stat = await fs.promises.lstat(target);
    } catch {
        return;
    }
    if (stat.isSymbolicLink()) return;
    await fs.promises.chmod(target, stat.isDirectory() ? 0o777 : 0o666).catch(() => { });
    if (stat.isDirectory()) {
        const entries = await fs.promises.readdir(target).catch(() => []);
        for (const entry of entries) {
            await makeWritable(path.join(target, entry));
        }
    }
}

async function removeFolder(target) {
    await makeWritable(target);
    await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (fs.existsSync(target)) {
        throw new Error('The folder could not be removed completely. A file may be in use.');
    }
}

async function describe(ext) {
    const dir = ext.dir;
    const commit = await git(dir, ['rev-parse', 'HEAD']);
    const branch = (await gitOrNull(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])) || '';
    const remoteUrl = cleanMessage(await gitOrNull(dir, ['remote', 'get-url', 'origin'])) || '';
    let behind = 0;
    if (branch && branch !== 'HEAD') {
        behind = Number(await gitOrNull(dir, ['rev-list', '--count', `HEAD..origin/${branch}`])) || 0;
    }
    const prevCommit = (await gitOrNull(dir, ['rev-parse', '-q', '--verify', PREV_REF])) || '';
    return {
        currentBranchName: branch === 'HEAD' ? '' : branch,
        currentCommitHash: commit,
        isUpToDate: behind === 0,
        behind,
        remoteUrl,
        prevCommit,
        canRollback: Boolean(prevCommit) && prevCommit !== commit,
        dirty: await isDirty(dir),
    };
}

/** Wraps a handler so every failure becomes `{ error: "reason" }` that the cart can show. */
function route(handler) {
    return async (request, response) => {
        try {
            response.json(await handler(request));
        } catch (error) {
            const status = error instanceof HttpError ? error.status : 500;
            const message = error instanceof Error ? error.message : String(error);
            if (status === 500) console.error('[ext-cart]', request.path, message);
            response.status(status).json({ error: cleanMessage(message) || 'Unknown error.' });
        }
    };
}

export async function init(router) {
    gitAvailable = await new Promise(resolve => execFile('git', ['--version'], { windowsHide: true }, error => resolve(!error)));

    router.get('/probe', (_request, response) => {
        response.json({ ok: true, version: VERSION, gitAvailable });
    });

    // Update check: one fetch, then compare with the remote branch
    router.post('/version', route(async (request) => {
        const ext = resolveExtension(request);
        if (!ext.isRepo || !gitAvailable) {
            return { currentBranchName: '', currentCommitHash: '', isUpToDate: true, remoteUrl: '', noGit: true };
        }
        await git(ext.dir, ['fetch', 'origin']);
        return describe(ext);
    }));

    // Update. force=false: fast-forward only. force=true: make the folder equal to the remote branch.
    router.post('/update', route(async (request) => {
        const ext = resolveExtension(request);
        requireRepo(ext);
        const force = Boolean(request.body.force);
        const branch = await currentBranch(ext.dir);
        const before = await git(ext.dir, ['rev-parse', 'HEAD']);
        await git(ext.dir, ['fetch', 'origin']);
        const target = await gitOrNull(ext.dir, ['rev-parse', '-q', '--verify', `origin/${branch}`]);
        if (!target) {
            throw new HttpError(500, `The remote has no branch named ${branch}.`);
        }
        const remoteUrl = cleanMessage(await gitOrNull(ext.dir, ['remote', 'get-url', 'origin'])) || '';
        if (target === before) {
            return { isUpToDate: true, shortCommitHash: before.slice(0, 7), remoteUrl };
        }

        let backupPath = '';
        if (force) {
            if (await isDirty(ext.dir)) {
                backupPath = await backupFolder(request, ext);
            }
            await git(ext.dir, ['reset', '--hard', `origin/${branch}`]);
        } else {
            await git(ext.dir, ['pull', '--ff-only', 'origin', branch]);
        }

        const after = await git(ext.dir, ['rev-parse', 'HEAD']);
        if (after !== before) {
            await git(ext.dir, ['update-ref', PREV_REF, before]);
        }
        return { isUpToDate: after === before, shortCommitHash: after.slice(0, 7), previousCommit: before, remoteUrl, backupPath };
    }));

    // Go back to the commit the extension was on before the last update (calling it again goes forward)
    router.post('/rollback', route(async (request) => {
        const ext = resolveExtension(request);
        requireRepo(ext);
        const current = await git(ext.dir, ['rev-parse', 'HEAD']);
        const previous = await gitOrNull(ext.dir, ['rev-parse', '-q', '--verify', PREV_REF]);
        if (!previous || previous === current) {
            throw new HttpError(400, 'There is no earlier version to go back to.');
        }
        let backupPath = '';
        if (await isDirty(ext.dir)) {
            backupPath = await backupFolder(request, ext);
        }
        await git(ext.dir, ['reset', '--hard', previous]);
        await git(ext.dir, ['update-ref', PREV_REF, current]);
        return { shortCommitHash: previous.slice(0, 7), previousCommit: current, backupPath };
    }));

    router.post('/delete', route(async (request) => {
        const ext = resolveExtension(request);
        await removeFolder(ext.dir);
        console.info('[ext-cart] Deleted', ext.dir);
        return { ok: true };
    }));

    console.log(`[ext-cart] Server plugin ready (git ${gitAvailable ? 'found' : 'NOT found'}).`);
}

export async function exit() { }
