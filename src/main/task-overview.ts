/**
 * Cross-repo task overview (T-900).
 *
 * Reads every profile's Ordna board through @frehilm/ordna-core and boils
 * it down to a per-project summary: status buckets, ready / blocked /
 * stalled counts and a plain-language one-liner. Deliberately free of
 * Electron imports so the aggregation can move into ordna-core later.
 *
 * Strictly read-only. Ordna backends create state on first use (file and
 * hybrid `mkdir` the tasks dir, namespace writes `refs/ordna/state`), so a
 * directory is only opened when that state already exists, and every
 * backend is disposed after listing so namespace auto-fetch timers never
 * outlive the call.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Task } from '@frehilm/ordna-core';
import type {
  ParallelAgent,
  Profile,
  TaskBucket,
  TaskOverviewCounts,
  TaskOverviewProject,
  TaskOverviewResult,
  TaskOverviewTask,
} from '../shared/types';

/** In-progress tasks untouched for this many days are flagged as stalled. */
export const STALE_DAYS = 14;
const CONCURRENCY = 6;
const GIT_TIMEOUT_MS = 5000;
const ARCHIVED = 'archived';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Parallel-agent phases that mean "an agent is actively on this task". */
const LIVE_AGENT_PHASES = new Set<ParallelAgent['phase']>(['starting', 'awaiting', 'running', 'pushing']);

type OrdnaCore = typeof import('@frehilm/ordna-core');
let corePromise: Promise<OrdnaCore> | null = null;
// ESM-only package, externalised in vite.main.config.ts — load it the same
// way OrdnaManager loads @frehilm/ordna-web.
function loadCore(): Promise<OrdnaCore> {
  if (!corePromise) corePromise = import('@frehilm/ordna-core');
  return corePromise;
}

// ── Pure helpers (no I/O) ───────────────────────────────────────────

/** Map a raw status onto a repo-independent bucket by its position in the
 * repo's configured `statuses`. */
export function bucketFor(status: string, statuses: string[]): { bucket: TaskBucket; unknown: boolean } {
  if (status.toLowerCase() === ARCHIVED) return { bucket: 'archived', unknown: false };
  let idx = statuses.indexOf(status);
  if (idx < 0) {
    const lower = status.toLowerCase();
    idx = statuses.findIndex((s) => s.toLowerCase() === lower);
  }
  if (idx < 0) return { bucket: 'open', unknown: true };
  if (statuses.length === 1 || idx === 0) return { bucket: 'open', unknown: false };
  if (idx === statuses.length - 1) return { bucket: 'done', unknown: false };
  return { bucket: 'doing', unknown: false };
}

/** Normalise a frontmatter date (string or Date) to `YYYY-MM-DD`, or '' if unusable. */
export function toIsoDate(value: unknown): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  if (typeof value !== 'string' || !value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function daysSince(isoDate: string, now: Date): number {
  if (!isoDate) return Infinity;
  return Math.floor((now.getTime() - new Date(isoDate).getTime()) / DAY_MS);
}

export function relativeDays(isoDate: string | null, now: Date): string {
  if (!isoDate) return 'never';
  const d = daysSince(isoDate, now);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.round(d / 7)} weeks ago`;
  if (d < 365) return `${Math.round(d / 30)} months ago`;
  return `${Math.round(d / 365)} year${d >= 548 ? 's' : ''} ago`;
}

// Unset sits between medium and low: most Ordna tasks carry no priority,
// and an explicit `low` is a signal to push it down.
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 3 };
export function priorityRank(p: TaskOverviewTask['priority']): number {
  return p ? PRIORITY_RANK[p] : 2;
}

/** Sort for "what should I look at": in progress, then ready, then blocked;
 * within each, priority first, then most recently updated. */
export function compareTasks(a: TaskOverviewTask, b: TaskOverviewTask): number {
  const group = (t: TaskOverviewTask) => (t.bucket === 'doing' ? 0 : t.ready ? 1 : 2);
  return (
    group(a) - group(b) ||
    priorityRank(a.priority) - priorityRank(b.priority) ||
    b.updated_at.localeCompare(a.updated_at)
  );
}

export function summarise(counts: TaskOverviewCounts, lastActivity: string | null, now: Date): string {
  const parts: string[] = [];
  if (counts.doing > 0) {
    parts.push(`${counts.doing} in progress${counts.stalled > 0 ? ` (${counts.stalled} stalled)` : ''}`);
  }
  if (counts.ready > 0) {
    parts.push(`${counts.ready} ready to start${counts.highReady > 0 ? ` (${counts.highReady} high)` : ''}`);
  }
  if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`);
  if (parts.length === 0) parts.push(counts.done > 0 ? 'All done' : 'No open tasks');
  if (lastActivity) parts.push(`last activity ${relativeDays(lastActivity, now)}`);
  return parts.join(' · ');
}

/** Turn a repo's raw Ordna tasks into overview tasks + counts. */
export function analyseTasks(
  tasks: Pick<Task, 'id' | 'title' | 'status' | 'priority' | 'assignee' | 'tags' | 'depends_on' | 'updated_at'>[],
  statuses: string[],
  agentTaskIds: Set<string>,
  now: Date,
): { tasks: TaskOverviewTask[]; counts: TaskOverviewCounts; lastActivity: string | null } {
  const counts: TaskOverviewCounts = {
    open: 0, ready: 0, blocked: 0, doing: 0, stalled: 0, done: 0, archived: 0, highReady: 0,
  };
  const bucketed = tasks.map((t) => ({ t, ...bucketFor(String(t.status ?? ''), statuses) }));
  const allIds = new Set(bucketed.map((b) => b.t.id));
  const doneIds = new Set(bucketed.filter((b) => b.bucket === 'done' || b.bucket === 'archived').map((b) => b.t.id));

  let lastActivity: string | null = null;
  const out: TaskOverviewTask[] = [];
  for (const { t, bucket, unknown } of bucketed) {
    const updated = toIsoDate(t.updated_at);
    if (updated && (!lastActivity || updated > lastActivity)) lastActivity = updated;
    counts[bucket]++;
    if (bucket === 'done' || bucket === 'archived') continue;

    const deps = Array.isArray(t.depends_on) ? t.depends_on : [];
    // A dependency on an id that doesn't exist in this repo can't be
    // resolved here — don't let it block the task forever.
    const ready = bucket === 'open' && deps.every((d) => doneIds.has(d) || !allIds.has(d));
    const blocked = bucket === 'open' && !ready;
    const stalled = bucket === 'doing' && daysSince(updated, now) >= STALE_DAYS;
    if (ready) counts.ready++;
    if (blocked) counts.blocked++;
    if (stalled) counts.stalled++;
    if (ready && t.priority === 'high') counts.highReady++;

    out.push({
      id: t.id,
      title: t.title,
      status: String(t.status ?? ''),
      bucket,
      unknownStatus: unknown,
      priority: t.priority ?? null,
      assignee: t.assignee ?? null,
      tags: Array.isArray(t.tags) ? t.tags : [],
      depends_on: deps,
      ready,
      blocked,
      stalled,
      updated_at: updated,
      agentRunning: agentTaskIds.has(t.id),
    });
  }
  out.sort(compareTasks);
  return { tasks: out, counts, lastActivity };
}

// ── I/O ─────────────────────────────────────────────────────────────

export function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function displayPath(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

function resolveDir(workingDirectory: string): string {
  const abs = path.resolve(expandHome(workingDirectory));
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Run git without a shell. Resolves stdout (trimmed) or null on failure. */
function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

async function currentBranch(dir: string): Promise<string | null> {
  const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch) return null;
  if (branch !== 'HEAD') return branch;
  const sha = await git(dir, ['rev-parse', '--short', 'HEAD']);
  return sha ? `detached @ ${sha}` : null;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface ReadResult {
  state: TaskOverviewProject['state'];
  error?: string;
  storage: TaskOverviewProject['storage'];
  statuses: string[];
  tasks: Task[];
}

/** Read one directory's tasks without creating any Ordna state. */
async function readBoard(dir: string): Promise<ReadResult> {
  const none: ReadResult = { state: 'none', storage: null, statuses: [], tasks: [] };
  if (!fs.existsSync(dir)) return none;
  const core = await loadCore();
  const hasConfig = fs.existsSync(path.join(dir, '.ordna', 'config.yaml'));
  const config = core.loadConfig({ cwd: dir });

  if (config.storage === 'namespace') {
    // `--quiet` prints nothing; success resolves '' (not null).
    const hasState = (await git(dir, ['show-ref', '--verify', '--quiet', 'refs/ordna/state'])) !== null;
    if (!hasState) return none;
  } else {
    const tasksDir = core.resolveTasksDir(config, dir);
    if (!fs.existsSync(tasksDir) || !fs.statSync(tasksDir).isDirectory()) return none;
  }

  const ctx = core.createContext(dir);
  let tasks: Task[];
  try {
    tasks = await core.listTasks(ctx);
  } finally {
    await ctx.backend.dispose().catch((): void => undefined);
  }
  // A bare `tasks/` folder with no Ordna files in it isn't an Ordna board.
  if (!hasConfig && tasks.length === 0) return none;
  return { state: 'ok', storage: config.storage, statuses: config.statuses, tasks };
}

export async function collectTaskOverview(
  profiles: Profile[],
  parallelAgents: ParallelAgent[],
  now: Date = new Date(),
): Promise<TaskOverviewResult> {
  // One project per resolved working directory — that's the cwd Vyb's
  // Kanban runs Ordna in, so it's the unit a board is scoped to.
  const groups = new Map<string, Profile[]>();
  for (const p of profiles) {
    if (!p.workingDirectory) continue;
    const key = resolveDir(p.workingDirectory);
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }

  const projects = await mapLimit([...groups.entries()], CONCURRENCY, async ([dir, members]): Promise<TaskOverviewProject> => {
    const primary = members[0];
    const profileIds = members.map((m) => m.id);
    const agentTaskIds = new Set(
      parallelAgents
        .filter((a) => profileIds.includes(a.profileId) && a.kind !== 'session' && LIVE_AGENT_PHASES.has(a.phase))
        .map((a) => a.taskId),
    );
    const base = {
      key: dir,
      profileId: primary.id,
      profileIds,
      name: primary.name,
      path: displayPath(dir),
      workspaceId: primary.workspaceId ?? null,
    };
    const emptyCounts: TaskOverviewCounts = {
      open: 0, ready: 0, blocked: 0, doing: 0, stalled: 0, done: 0, archived: 0, highReady: 0,
    };

    // Outside the try so a broken board still shows which branch it's on.
    const branch = fs.existsSync(dir) ? await currentBranch(dir) : null;
    try {
      const board = await readBoard(dir);
      if (board.state !== 'ok') {
        return {
          ...base, branch, storage: board.storage, state: board.state, statuses: [],
          counts: emptyCounts, lastActivity: null, summary: 'No Ordna board', tasks: [],
        };
      }
      const { tasks, counts, lastActivity } = analyseTasks(board.tasks, board.statuses, agentTaskIds, now);
      return {
        ...base, branch, storage: board.storage, state: 'ok', statuses: board.statuses,
        counts, lastActivity, summary: summarise(counts, lastActivity, now), tasks,
      };
    } catch (err) {
      return {
        ...base, branch, storage: null, state: 'error', error: (err as Error).message,
        statuses: [], counts: emptyCounts, lastActivity: null, summary: 'Could not read tasks', tasks: [],
      };
    }
  });

  projects.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '') || a.name.localeCompare(b.name));
  return { generatedAt: now.toISOString(), staleDays: STALE_DAYS, projects };
}
