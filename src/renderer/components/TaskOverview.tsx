import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  TaskOverviewCounts,
  TaskOverviewProject,
  TaskOverviewResult,
  TaskOverviewTask,
  Workspace,
} from '../../shared/types';

/**
 * Cross-repo task overview (T-061). A read-only summary of every profile's
 * Ordna board: one plain-language line per project plus a flat, filterable
 * task list. Detail stays in each project's own Kanban — "Open board" jumps
 * there.
 */

interface TaskOverviewProps {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  kanbanEnabled: boolean;
  onOpenBoard: (profileId: string) => void;
  onClose: () => void;
}

type View = 'projects' | 'tasks';
type Scope = 'workspace' | 'all';
type TaskFilter = 'ready' | 'doing' | 'blocked' | 'stalled' | 'open';
type PriorityFilter = 'any' | 'high' | 'medium';

const TASK_FILTERS: { id: TaskFilter; label: string }[] = [
  { id: 'ready', label: 'Ready' },
  { id: 'doing', label: 'In progress' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'stalled', label: 'Stalled' },
  { id: 'open', label: 'All open' },
];

const DAY_MS = 24 * 60 * 60 * 1000;
function relativeDays(iso: string | null): string {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d}d ago`;
  if (d < 60) return `${Math.round(d / 7)}w ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

function matchesFilter(t: TaskOverviewTask, f: TaskFilter): boolean {
  switch (f) {
    case 'ready': return t.ready;
    case 'doing': return t.bucket === 'doing';
    case 'blocked': return t.blocked;
    case 'stalled': return t.stalled;
    case 'open': return true;
  }
}

function matchesPriority(t: TaskOverviewTask, p: PriorityFilter): boolean {
  if (p === 'any') return true;
  if (p === 'high') return t.priority === 'high';
  return t.priority === 'high' || t.priority === 'medium';
}

function sumCounts(projects: TaskOverviewProject[]): TaskOverviewCounts {
  const total: TaskOverviewCounts = { open: 0, ready: 0, blocked: 0, doing: 0, stalled: 0, done: 0, archived: 0, highReady: 0 };
  for (const p of projects) {
    for (const k of Object.keys(total) as (keyof TaskOverviewCounts)[]) total[k] += p.counts[k];
  }
  return total;
}

function taskState(t: TaskOverviewTask): { label: string; cls: string } {
  if (t.bucket === 'doing') return t.stalled ? { label: 'stalled', cls: 'stalled' } : { label: 'in progress', cls: 'doing' };
  if (t.blocked) return { label: 'blocked', cls: 'blocked' };
  return { label: 'ready', cls: 'ready' };
}

function StatusBar({ counts }: { counts: TaskOverviewCounts }) {
  const segments = [
    { n: counts.doing, cls: 'doing', label: 'in progress' },
    { n: counts.ready, cls: 'ready', label: 'ready' },
    { n: counts.blocked, cls: 'blocked', label: 'blocked' },
    { n: counts.done, cls: 'done', label: 'done' },
  ];
  const total = segments.reduce((s, x) => s + x.n, 0);
  if (total === 0) return <div className="to-bar to-bar-empty" />;
  return (
    <div className="to-bar" title={segments.map((s) => `${s.n} ${s.label}`).join(' · ')}>
      {segments.map((s) => (s.n > 0 ? (
        <span key={s.cls} className={`to-bar-seg to-${s.cls}`} style={{ flexGrow: s.n }} />
      ) : null))}
    </div>
  );
}

function TaskRow({ task, project, showProject, onOpen }: {
  task: TaskOverviewTask;
  project: TaskOverviewProject;
  showProject: boolean;
  onOpen: () => void;
}) {
  const state = taskState(task);
  return (
    <button className="to-task" onClick={onOpen} title={`Open ${project.name} board`}>
      {showProject && <span className="to-task-project">{project.name}</span>}
      <span className="to-task-id">{task.id}</span>
      <span className="to-task-title">{task.title}</span>
      {task.agentRunning && <span className="to-chip to-agent" title="A parallel agent is working on this task">agent</span>}
      {task.priority && <span className={`to-chip to-prio-${task.priority}`}>{task.priority}</span>}
      <span className={`to-chip to-${state.cls}`} title={`Status: ${task.status}${task.unknownStatus ? ' (not in this repo’s status list)' : ''}`}>
        {state.label}
      </span>
      <span className="to-task-age">{relativeDays(task.updated_at)}</span>
    </button>
  );
}

function ProjectCard({ project, expanded, onToggle, onOpenBoard, kanbanEnabled }: {
  project: TaskOverviewProject;
  expanded: boolean;
  onToggle: () => void;
  onOpenBoard: () => void;
  kanbanEnabled: boolean;
}) {
  const openCount = project.counts.open + project.counts.doing;
  return (
    <div className={`to-card${project.state === 'error' ? ' to-card-error' : ''}`}>
      <div className="to-card-head">
        <div className="to-card-title">
          <span className="to-card-name">{project.name}</span>
          {project.profileIds.length > 1 && (
            <span className="to-chip" title="Several profiles share this directory">×{project.profileIds.length}</span>
          )}
          {project.branch && <span className="to-chip to-branch" title="Checked-out branch — file/hybrid boards follow it">{project.branch}</span>}
          {project.storage && project.storage !== 'file' && <span className="to-chip">{project.storage}</span>}
        </div>
        <div className="to-card-actions">
          {project.state === 'ok' && openCount > 0 && (
            <button className="to-btn to-btn-ghost" onClick={onToggle}>
              {expanded ? 'Hide tasks' : `Show ${openCount} task${openCount === 1 ? '' : 's'}`}
            </button>
          )}
          <button className="to-btn" onClick={onOpenBoard}>{kanbanEnabled ? 'Open board' : 'Go to profile'}</button>
        </div>
      </div>
      <div className="to-card-path">{project.path}</div>
      {project.state === 'error' ? (
        <div className="to-card-summary to-error-text">Could not read tasks: {project.error}</div>
      ) : project.state === 'none' ? (
        <div className="to-card-summary to-muted">No Ordna board in this directory</div>
      ) : (
        <>
          <div className="to-card-summary">{project.summary}</div>
          <StatusBar counts={project.counts} />
        </>
      )}
      {expanded && (
        <div className="to-card-tasks">
          {project.tasks.map((t) => (
            <TaskRow key={t.id} task={t} project={project} showProject={false} onOpen={onOpenBoard} />
          ))}
        </div>
      )}
    </div>
  );
}

export function TaskOverview({ workspaces, activeWorkspaceId, kanbanEnabled, onOpenBoard, onClose }: TaskOverviewProps) {
  const [data, setData] = useState<TaskOverviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>('projects');
  const [scope, setScope] = useState<Scope>(workspaces.length > 1 ? 'workspace' : 'all');
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('ready');
  const [priority, setPriority] = useState<PriorityFilter>('any');
  const [query, setQuery] = useState('');
  const [showEmpty, setShowEmpty] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setData(await window.api.getTaskOverview());
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on open, and again whenever the window regains focus — tasks are
  // often edited in another app or by an agent while you're away.
  useEffect(() => {
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const defaultWorkspaceId = workspaces[0]?.id ?? null;
  const inScope = useMemo(() => {
    const all = data?.projects ?? [];
    if (scope === 'all') return all;
    return all.filter((p) => (p.workspaceId ?? defaultWorkspaceId) === activeWorkspaceId);
  }, [data, scope, activeWorkspaceId, defaultWorkspaceId]);

  const boards = useMemo(() => inScope.filter((p) => p.state !== 'none'), [inScope]);
  const hiddenCount = inScope.length - boards.length;
  const totals = useMemo(() => sumCounts(boards), [boards]);
  const q = query.trim().toLowerCase();

  // Projects view: grouped by workspace (in sidebar order) when showing all.
  const groups = useMemo(() => {
    const visible = (showEmpty ? inScope : boards).filter((p) =>
      !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
      || p.tasks.some((t) => t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)));
    if (scope === 'workspace') return [{ id: activeWorkspaceId ?? '', name: '', projects: visible }];
    const byWs = new Map<string, TaskOverviewProject[]>();
    for (const p of visible) {
      const ws = p.workspaceId ?? defaultWorkspaceId ?? '';
      const list = byWs.get(ws);
      if (list) list.push(p);
      else byWs.set(ws, [p]);
    }
    return workspaces
      .filter((w) => byWs.has(w.id))
      .map((w) => ({ id: w.id, name: w.name, projects: byWs.get(w.id) ?? [] }));
  }, [inScope, boards, showEmpty, q, scope, activeWorkspaceId, defaultWorkspaceId, workspaces]);

  // Tasks view: flat list across every board in scope.
  const flatTasks = useMemo(() => {
    const rows: { task: TaskOverviewTask; project: TaskOverviewProject }[] = [];
    for (const project of boards) {
      for (const task of project.tasks) {
        if (!matchesFilter(task, taskFilter) || !matchesPriority(task, priority)) continue;
        if (q && !task.title.toLowerCase().includes(q) && !task.id.toLowerCase().includes(q)
          && !project.name.toLowerCase().includes(q) && !task.tags.some((tag) => tag.toLowerCase().includes(q))) continue;
        rows.push({ task, project });
      }
    }
    // Same ranking as main's compareTasks: unset sits between medium and low.
    const rank = (p: TaskOverviewTask['priority']) => (p === 'high' ? 0 : p === 'medium' ? 1 : p === 'low' ? 3 : 2);
    rows.sort((a, b) => rank(a.task.priority) - rank(b.task.priority) || b.task.updated_at.localeCompare(a.task.updated_at));
    return rows;
  }, [boards, taskFilter, priority, q]);

  const toggleExpanded = (key: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const activeWorkspaceName = workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? 'this workspace';
  const headline = boards.length === 0
    ? 'No Ordna boards found'
    : [
      totals.doing > 0 && `${totals.doing} in progress`,
      totals.ready > 0 && `${totals.ready} ready to start`,
      totals.blocked > 0 && `${totals.blocked} blocked`,
      totals.stalled > 0 && `${totals.stalled} stalled`,
    ].filter(Boolean).join(' · ') + ` across ${boards.length} project${boards.length === 1 ? '' : 's'}`;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal task-overview" onClick={(e) => e.stopPropagation()}>
        <div className="to-header">
          <div>
            <h3>Task Overview</h3>
            <div className="to-headline">{loading && !data ? 'Reading boards…' : headline}</div>
          </div>
          <div className="to-header-actions">
            <button className="to-btn to-btn-ghost" onClick={refresh} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
            <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        <div className="to-toolbar">
          <div className="to-segmented">
            <button className={view === 'projects' ? 'active' : ''} onClick={() => setView('projects')}>Projects</button>
            <button className={view === 'tasks' ? 'active' : ''} onClick={() => setView('tasks')}>Tasks</button>
          </div>
          {workspaces.length > 1 && (
            <div className="to-segmented">
              <button className={scope === 'workspace' ? 'active' : ''} onClick={() => setScope('workspace')}>{activeWorkspaceName}</button>
              <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>All workspaces</button>
            </div>
          )}
          <input
            className="to-search"
            placeholder={view === 'projects' ? 'Filter projects or tasks…' : 'Filter by title, id, tag or project…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>

        {view === 'tasks' && (
          <div className="to-toolbar to-toolbar-secondary">
            <div className="to-segmented">
              {TASK_FILTERS.map((f) => (
                <button key={f.id} className={taskFilter === f.id ? 'active' : ''} onClick={() => setTaskFilter(f.id)}>{f.label}</button>
              ))}
            </div>
            <select className="to-select" value={priority} onChange={(e) => setPriority(e.target.value as PriorityFilter)}>
              <option value="any">Any priority</option>
              <option value="high">High only</option>
              <option value="medium">Medium and up</option>
            </select>
          </div>
        )}

        <div className="to-body">
          {loadError && <div className="to-error-text">Couldn’t build the overview: {loadError}</div>}

          {view === 'projects' && (
            <>
              {groups.every((g) => g.projects.length === 0) && !loading && (
                <div className="to-empty">
                  {q ? 'Nothing matches that filter.' : 'No profiles in this scope have an Ordna board yet.'}
                </div>
              )}
              {groups.map((g) => g.projects.length > 0 && (
                <section key={g.id} className="to-group">
                  {g.name && <h4 className="to-group-title">{g.name}</h4>}
                  {g.projects.map((p) => (
                    <ProjectCard
                      key={p.key}
                      project={p}
                      expanded={expanded.has(p.key)}
                      onToggle={() => toggleExpanded(p.key)}
                      onOpenBoard={() => onOpenBoard(p.profileId)}
                      kanbanEnabled={kanbanEnabled}
                    />
                  ))}
                </section>
              ))}
              {hiddenCount > 0 && (
                <label className="to-show-empty">
                  <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
                  Show {hiddenCount} profile{hiddenCount === 1 ? '' : 's'} without an Ordna board
                </label>
              )}
            </>
          )}

          {view === 'tasks' && (
            <div className="to-task-list">
              {flatTasks.length === 0 && !loading && <div className="to-empty">No tasks match.</div>}
              {flatTasks.map(({ task, project }) => (
                <TaskRow
                  key={`${project.key}:${task.id}`}
                  task={task}
                  project={project}
                  showProject
                  onOpen={() => onOpenBoard(project.profileId)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
