/**
 * mini-claude Eval Portal — local web UI to review judge results.
 *
 * Serves a single-page app backed by the JSONL logs in eval/runs/.
 * Design language borrowed from DailySync (same font stack, same neutral +
 * sky-blue palette, same card-with-soft-border style).
 *
 * Usage:
 *   bun run eval/portal.ts
 *   bun run eval/portal.ts --port=3456
 */

import { readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { TASKS } from './tasks.ts'
import { runTaskStream } from './run-task.ts'

const args = process.argv.slice(2)
const portArg = args.find(a => a.startsWith('--port='))
const PORT = portArg ? parseInt(portArg.slice('--port='.length), 10) : 3333
const RUNS_DIR = join(import.meta.dir, 'runs')

// ── Data access ──────────────────────────────────────────────────────────────

type RunSummary = {
  file: string
  timestamp: string
  sizeKb: number
  model?: string
  judgeModel?: string
  taskCount?: number
  passed?: number
  failed?: number
  errors?: number
}

async function listRuns(): Promise<RunSummary[]> {
  try {
    const entries = readdirSync(RUNS_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .reverse()
    const summaries: RunSummary[] = []
    for (const file of entries) {
      const full = join(RUNS_DIR, file)
      const size = statSync(full).size
      const text = await Bun.file(full).text()
      const lines = text.trim().split('\n').filter(Boolean)
      let model: string | undefined
      let judgeModel: string | undefined
      let taskCount = 0
      let passed = 0
      let failed = 0
      let errors = 0
      for (const line of lines) {
        try {
          const ev = JSON.parse(line)
          if (ev.type === 'run_start') {
            model = ev.model
            judgeModel = ev.evaluatorModel ?? ev.judgeModel
          } else if (ev.type === 'task_result') {
            taskCount++
            if (ev.outcome === 'goal_met') passed++
            else if (ev.outcome === 'error') errors++
            else failed++
          }
        } catch {
          // skip malformed lines
        }
      }
      const timestamp = file.replace(/\.jsonl$/, '').replace(/-/g, (m, i) => (i === 10 || i === 13 || i === 16 ? ':' : m))
      summaries.push({
        file,
        timestamp,
        sizeKb: Math.round(size / 1024),
        model,
        judgeModel,
        taskCount,
        passed,
        failed,
        errors,
      })
    }
    return summaries
  } catch {
    return []
  }
}

async function getRun(file: string): Promise<Record<string, unknown>[] | null> {
  const full = join(RUNS_DIR, basename(file))
  try {
    const text = await Bun.file(full).text()
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
  } catch {
    return null
  }
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>mini-claude Eval</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #f3f4f6; --surface: #fff; --border: #e5e7eb;
      --text: #111827; --muted: #6b7280; --faint: #9ca3af;
      --sky: #0ea5e9; --sky-hover: #0284c7; --sky-light: #e0f2fe; --sky-text: #0369a1;
      --amber: #f59e0b; --amber-bg: #fef3c7; --amber-text: #92400e;
      --green: #16a34a; --green-bg: #f0fdf4; --green-border: #bbf7d0; --green-text: #166534;
      --red: #ef4444; --red-bg: #fef2f2; --red-border: #fecaca; --red-text: #991b1b;
      --purple: #a855f7; --purple-bg: #f3e8ff; --purple-text: #6b21a8;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
           background: var(--bg); color: var(--text); min-height: 100vh; }
    code, pre { font-family: 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace; }

    /* Header */
    header { background: var(--surface); border-bottom: 1px solid var(--border);
             padding: 14px 24px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
    .logo { font-size: 18px; font-weight: 900; letter-spacing: -0.04em; }
    .logo span { color: var(--sky); }
    .badge { font-size: 11px; font-weight: 600; background: var(--sky-light); color: var(--sky-text);
             padding: 3px 8px; border-radius: 20px; }

    /* Tab switcher in header */
    .tabs { display: flex; gap: 4px; margin-left: auto; }
    .tab {
      font-size: 13px; font-weight: 600; padding: 8px 16px;
      border-radius: 8px; cursor: pointer; color: var(--muted);
      background: transparent; border: 1px solid transparent;
      font-family: inherit;
    }
    .tab:hover { background: var(--bg); color: var(--text); }
    .tab.active { background: var(--sky-light); color: var(--sky-text); border-color: #bae6fd; }

    /* Task list in sidebar */
    .task-group-header {
      font-size: 10px; font-weight: 700; letter-spacing: 0.6px;
      text-transform: uppercase; color: var(--muted);
      padding: 16px 16px 6px; border-top: 1px solid var(--border);
    }
    .task-group-header:first-child { border-top: none; }
    .task-item {
      padding: 10px 16px; cursor: pointer;
      border-left: 3px solid transparent;
      transition: background 0.1s;
    }
    .task-item:hover { background: var(--bg); }
    .task-item.active { background: var(--sky-light); border-left-color: var(--sky); }
    .task-item-name { font-size: 12px; font-weight: 600; color: var(--text); font-family: 'SF Mono', monospace; }
    .task-item.active .task-item-name { color: var(--sky-text); }
    .task-item-goal { font-size: 11px; color: var(--muted); margin-top: 2px; line-height: 1.4; }

    /* Live run panel */
    .live-header {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px 24px;
      margin-bottom: 16px;
    }
    .live-header h2 { font-size: 18px; font-weight: 800; margin-bottom: 8px; }
    .live-header .goal { font-size: 14px; color: var(--muted); line-height: 1.5; }
    .run-btn {
      font-size: 14px; font-weight: 600; padding: 10px 20px;
      border-radius: 8px; border: 1px solid var(--sky); background: var(--sky); color: white;
      cursor: pointer; font-family: inherit; margin-top: 12px;
    }
    .run-btn:hover { background: var(--sky-hover); }
    .run-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .run-btn.stop { background: var(--red); border-color: var(--red); }

    .status-chip {
      display: inline-block; font-size: 11px; font-weight: 700;
      padding: 4px 10px; border-radius: 20px; letter-spacing: 0.3px;
      text-transform: uppercase;
    }
    .status-chip.idle { background: var(--bg); color: var(--muted); }
    .status-chip.running { background: var(--sky-light); color: var(--sky-text); }
    .status-chip.done-pass { background: var(--green-bg); color: var(--green-text); }
    .status-chip.done-fail { background: var(--red-bg); color: var(--red-text); }
    .status-chip.done-other { background: var(--amber-bg); color: var(--amber-text); }

    .pulse {
      display: inline-block; width: 8px; height: 8px; border-radius: 50%;
      background: var(--sky); margin-right: 6px;
      animation: pulse 1.2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.8); }
    }

    .live-chat {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      min-height: 400px;
      max-height: calc(100vh - 280px);
      overflow-y: auto;
    }

    .event-row {
      font-size: 12px; color: var(--muted); padding: 4px 0;
      font-family: 'SF Mono', monospace;
    }
    .event-row.info { color: var(--sky-text); }
    .event-row.success { color: var(--green-text); }
    .event-row.warn { color: var(--amber-text); }
    .event-row.error { color: var(--red-text); }

    /* Layout */
    .layout { display: grid; grid-template-columns: 320px 1fr; min-height: calc(100vh - 53px); }

    /* Sidebar */
    aside { background: var(--surface); border-right: 1px solid var(--border);
            padding: 16px 0; overflow-y: auto; position: sticky; top: 53px; height: calc(100vh - 53px); }
    .sidebar-title { font-size: 11px; font-weight: 600; letter-spacing: 0.6px; text-transform: uppercase;
                     color: var(--muted); padding: 0 16px 10px; }
    .run-item { padding: 12px 16px; border-bottom: 1px solid var(--border); cursor: pointer;
                transition: background 0.1s; }
    .run-item:hover { background: var(--bg); }
    .run-item.active { background: var(--sky-light); border-left: 3px solid var(--sky); }
    .run-item-name { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 4px; font-family: 'SF Mono', 'Menlo', monospace; }
    .run-item-meta { font-size: 11px; color: var(--muted); display: flex; gap: 8px; align-items: center; }
    .run-item.active .run-item-name { color: var(--sky-text); }
    .empty-sidebar { padding: 24px 16px; font-size: 13px; color: var(--muted); text-align: center; line-height: 1.6; }

    .mini-stat { font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 6px; }
    .mini-stat.pass { background: var(--green-bg); color: var(--green-text); }
    .mini-stat.fail { background: var(--red-bg); color: var(--red-text); }
    .mini-stat.err  { background: var(--amber-bg); color: var(--amber-text); }

    /* Main */
    main { padding: 28px; overflow-y: auto; }
    .placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center;
                   height: 60vh; color: var(--muted); text-align: center; gap: 10px; }
    .placeholder-icon { font-size: 40px; }
    .placeholder h2 { font-size: 16px; font-weight: 600; color: var(--text); }
    .placeholder p { font-size: 13px; max-width: 380px; line-height: 1.6; }
    .placeholder code { background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
                        padding: 10px 16px; font-size: 12px; display: block; margin-top: 8px; text-align: left; }

    /* Section titles */
    h2.section { font-size: 11px; font-weight: 600; letter-spacing: 0.6px; text-transform: uppercase;
                 color: var(--muted); margin: 0 0 12px; }
    section { margin-bottom: 28px; }

    /* Meta chips */
    .meta-bar { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
    .meta-chip { font-size: 12px; background: var(--surface); border: 1px solid var(--border);
                 border-radius: 20px; padding: 4px 12px; color: var(--muted); }
    .meta-chip strong { color: var(--text); font-weight: 600; }

    /* Score cards grid */
    .score-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
    .score-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
    .score-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
    .score-value { font-size: 28px; font-weight: 700; line-height: 1; }
    .score-sub { font-size: 11px; color: var(--muted); margin-top: 4px; }

    /* Task card */
    .task-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
                 padding: 18px 20px; margin-bottom: 14px; }
    .task-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .task-name { font-size: 14px; font-weight: 700; flex: 1; font-family: 'SF Mono', monospace; }
    .verdict-badge { font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.3px; }
    .verdict-badge.pass { background: var(--green-bg); color: var(--green-text); border: 1px solid var(--green-border); }
    .verdict-badge.fail { background: var(--red-bg); color: var(--red-text); border: 1px solid var(--red-border); }

    .task-meta { font-size: 11px; color: var(--muted); margin-bottom: 14px; display: flex; gap: 12px; flex-wrap: wrap; }
    .task-meta span strong { color: var(--text); }

    .task-goal { font-size: 12px; color: var(--muted); font-style: italic; line-height: 1.5; margin-bottom: 14px;
                 padding: 10px 12px; background: var(--bg); border-radius: 8px; }

    .expectations { margin-bottom: 14px; }
    .exp-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
    .exp-list li { font-size: 12px; line-height: 1.5; display: flex; gap: 8px; align-items: flex-start; }
    .exp-mark { font-weight: 700; flex-shrink: 0; width: 14px; }
    .exp-mark.pass { color: var(--green); }
    .exp-mark.fail { color: var(--red); }

    .reasoning { font-size: 12px; color: var(--muted); line-height: 1.5; padding: 10px 12px;
                 background: var(--bg); border-radius: 8px; border-left: 3px solid var(--sky); }

    /* Collapsible trajectory */
    details { margin-top: 12px; }
    summary { font-size: 11px; color: var(--muted); cursor: pointer; padding: 4px 0;
              text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; user-select: none; }
    summary:hover { color: var(--text); }
    details[open] summary { color: var(--text); margin-bottom: 8px; }

    pre.code-block { background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
                     padding: 12px; font-size: 11px; line-height: 1.5; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
    .tool-call-row { font-size: 12px; font-family: 'SF Mono', monospace; padding: 6px 10px;
                     background: var(--bg); border-radius: 6px; margin-bottom: 4px; overflow-x: auto; }
    .tool-call-name { color: var(--sky-text); font-weight: 600; }

    .loading { padding: 40px; color: var(--muted); text-align: center; font-size: 13px; }

    /* Chat bubble layout for the conversation view */
    .chat {
      background: var(--bg);
      border-radius: 12px;
      padding: 20px;
      margin-top: 12px;
      max-height: 800px;
      overflow-y: auto;
    }
    .chat-controls {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .chat-btn {
      font-size: 12px;
      font-weight: 600;
      padding: 6px 14px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--surface);
      cursor: pointer;
      color: var(--text);
      font-family: inherit;
    }
    .chat-btn:hover { background: var(--sky-light); border-color: var(--sky); color: var(--sky-text); }
    .chat-btn.playing { background: var(--sky); color: white; border-color: var(--sky); }

    .msg {
      margin-bottom: 16px;
      max-width: 85%;
      opacity: 0;
      transform: translateY(8px);
      animation: fadeIn 0.3s ease-out forwards;
    }
    @keyframes fadeIn {
      to { opacity: 1; transform: translateY(0); }
    }
    .msg.playback-hidden { display: none !important; }

    .msg-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .msg-bubble {
      padding: 12px 16px;
      border-radius: 14px;
      font-size: 14px;
      line-height: 1.55;
      word-wrap: break-word;
    }

    /* User (evaluator playing user) — left side, sky blue */
    .msg-user { margin-right: auto; }
    .msg-user .msg-label { color: var(--sky-text); }
    .msg-user .msg-bubble {
      background: var(--sky-light);
      border: 1px solid #bae6fd;
      border-bottom-left-radius: 4px;
    }

    /* mini-claude — right side, neutral */
    .msg-agent { margin-left: auto; }
    .msg-agent .msg-label { color: var(--text); justify-content: flex-end; }
    .msg-agent .msg-bubble {
      background: var(--surface);
      border: 1px solid var(--border);
      border-bottom-right-radius: 4px;
    }
    .msg-agent pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: 'SF Mono', ui-monospace, monospace;
      font-size: 12.5px;
      line-height: 1.6;
    }

    /* Permission prompt — centered with accent */
    .msg-permission {
      margin: 16px auto;
      max-width: 70%;
      text-align: center;
    }
    .msg-permission.approve .msg-bubble {
      background: var(--green-bg);
      border: 1px solid var(--green-border);
      color: var(--green-text);
    }
    .msg-permission.deny .msg-bubble {
      background: var(--red-bg);
      border: 1px solid var(--red-border);
      color: var(--red-text);
    }
    .msg-permission .msg-label { justify-content: center; }

    /* Evaluator thinking — centered, dashed gray bubble */
    .msg-evaluator {
      margin: 16px auto;
      max-width: 75%;
      text-align: center;
    }
    .msg-evaluator .msg-label { color: var(--muted); justify-content: center; }
    .msg-evaluator .msg-bubble {
      background: transparent;
      border: 1px dashed var(--border);
      color: var(--muted);
      font-style: italic;
      font-size: 13px;
    }
    .msg-evaluator .verdict-line {
      margin-top: 6px;
      font-style: normal;
      font-weight: 600;
    }
    .msg-evaluator .verdict-line.pass { color: var(--green-text); }
    .msg-evaluator .verdict-line.give-up { color: var(--amber-text); }
    .msg-evaluator .verdict-line.continue { color: var(--sky-text); }
  </style>
</head>
<body>
<header>
  <div class="logo">mini<span>·</span>claude</div>
  <span class="badge">Eval Portal</span>
  <div class="tabs">
    <button class="tab active" id="tab-tasks" onclick="switchTab('tasks')">▶ Run tasks</button>
    <button class="tab" id="tab-runs" onclick="switchTab('runs')">📊 Past runs</button>
  </div>
</header>

<div class="layout">
  <aside>
    <div id="sidebar-tasks-title" class="sidebar-title">Tasks</div>
    <div id="sidebar-runs-title" class="sidebar-title" style="display:none;">Runs</div>
    <div id="sidebar-content"><div class="loading">Loading…</div></div>
  </aside>
  <main id="main-panel">
    <div class="placeholder">
      <div class="placeholder-icon">▶</div>
      <h2>Select a task to run</h2>
      <p>Pick any task from the sidebar, then click ▶ Run to watch the evaluator drive mini-claude in real time.</p>
    </div>
  </main>
</div>

<script>
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

  // ── Tab switching ────────────────────────────────────────────────────────

  let currentTab = 'tasks';

  function switchTab(tab) {
    currentTab = tab;
    document.getElementById('tab-tasks').classList.toggle('active', tab === 'tasks');
    document.getElementById('tab-runs').classList.toggle('active', tab === 'runs');
    document.getElementById('sidebar-tasks-title').style.display = tab === 'tasks' ? '' : 'none';
    document.getElementById('sidebar-runs-title').style.display = tab === 'runs' ? '' : 'none';
    const panel = document.getElementById('main-panel');
    if (tab === 'tasks') {
      loadTaskSidebar();
      panel.innerHTML = '<div class="placeholder"><div class="placeholder-icon">▶</div><h2>Select a task to run</h2><p>Pick any task from the sidebar, then click ▶ Run to watch the evaluator drive mini-claude in real time.</p></div>';
    } else {
      loadSidebar();
      panel.innerHTML = '<div class="placeholder"><div class="placeholder-icon">◈</div><h2>Select a run</h2><p>Pick an eval run from the sidebar to see past results.</p></div>';
    }
  }

  // ── Task list sidebar ────────────────────────────────────────────────────

  async function loadTaskSidebar() {
    const el = document.getElementById('sidebar-content');
    el.innerHTML = '<div class="loading">Loading tasks…</div>';
    const res = await fetch('/api/tasks');
    const tasks = await res.json();
    if (!tasks.length) {
      el.innerHTML = '<div class="empty-sidebar">No tasks defined.</div>';
      return;
    }

    // Group tasks by prefix
    const groups = { core: [], web: [], mcp: [], github: [], medium: [], hard: [] };
    for (const t of tasks) {
      if (t.name.startsWith('web_search_')) groups.web.push(t);
      else if (t.name.startsWith('mcp_')) groups.mcp.push(t);
      else if (t.name.startsWith('github_')) groups.github.push(t);
      else if (t.name.startsWith('medium_')) groups.medium.push(t);
      else if (t.name.startsWith('hard_')) groups.hard.push(t);
      else groups.core.push(t);
    }

    const groupLabels = {
      core: 'Core (file tools + permissions)',
      web: 'Web search',
      mcp: 'MCP (test server)',
      github: 'GitHub integration',
      medium: 'Medium difficulty',
      hard: 'Hard (north star)',
    };

    let html = '';
    for (const [key, list] of Object.entries(groups)) {
      if (!list.length) continue;
      html += '<div class="task-group-header">' + groupLabels[key] + '</div>';
      for (const t of list) {
        html += '<div class="task-item" data-task="' + esc(t.name) + '" onclick="selectTask(\\'' + esc(t.name) + '\\')">';
        html += '<div class="task-item-name">' + esc(t.name) + '</div>';
        html += '<div class="task-item-goal">' + esc((t.goal || '').slice(0, 100)) + (t.goal && t.goal.length > 100 ? '…' : '') + '</div>';
        html += '</div>';
      }
    }
    el.innerHTML = html;
  }

  let currentTask = null;

  async function selectTask(taskName) {
    currentTask = taskName;
    document.querySelectorAll('.task-item').forEach(el => {
      el.classList.toggle('active', el.dataset.task === taskName);
    });
    const res = await fetch('/api/tasks');
    const tasks = await res.json();
    const task = tasks.find(t => t.name === taskName);
    if (!task) return;
    renderTaskPanel(task);
  }

  function renderTaskPanel(task) {
    const panel = document.getElementById('main-panel');
    let html = '<div class="live-header">';
    html += '<div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;">';
    html += '<h2 style="flex:1; margin:0;">' + esc(task.name) + '</h2>';
    html += '<span id="status-chip" class="status-chip idle">Ready</span>';
    html += '</div>';
    html += '<div class="goal"><strong>Goal:</strong> ' + esc(task.goal) + '</div>';
    if (task.persona) html += '<div class="goal" style="margin-top:6px;"><strong>Persona:</strong> ' + esc(task.persona) + '</div>';
    if (task.successCriteria && task.successCriteria.length) {
      html += '<div class="goal" style="margin-top:10px;"><strong>Success criteria:</strong><ul style="margin:4px 0 0 20px; padding:0;">';
      for (const c of task.successCriteria) html += '<li style="margin:2px 0;">' + esc(c) + '</li>';
      html += '</ul></div>';
    }
    html += '<button id="run-btn" class="run-btn" onclick="startRun(\\'' + esc(task.name) + '\\')">▶ Run task</button>';
    html += '</div>';

    html += '<div class="live-chat" id="live-chat"><div style="color:var(--muted); text-align:center; padding:40px; font-size:14px;">Click ▶ Run task to start the evaluation. You\\'ll see events stream in live.</div></div>';

    panel.innerHTML = html;
  }

  // ── Live run streaming ───────────────────────────────────────────────────

  let currentEventSource = null;
  let currentRunTaskName = null;

  function startRun(taskName) {
    if (currentEventSource) {
      currentEventSource.close();
      currentEventSource = null;
    }
    currentRunTaskName = taskName;
    const chat = document.getElementById('live-chat');
    chat.innerHTML = '';
    const btn = document.getElementById('run-btn');
    btn.classList.add('stop');
    btn.textContent = '⏹ Stop task';
    btn.onclick = () => stopRun();
    const chip = document.getElementById('status-chip');
    chip.className = 'status-chip running';
    chip.innerHTML = '<span class="pulse"></span>Running';

    currentEventSource = new EventSource('/api/run/' + encodeURIComponent(taskName));
    currentEventSource.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        handleLiveEvent(ev);
      } catch (err) {
        console.error('parse error', err);
      }
    };
    currentEventSource.onerror = () => {
      // Fires on close
      if (currentEventSource) {
        currentEventSource.close();
        currentEventSource = null;
      }
      resetRunButton();
    };
  }

  function stopRun() {
    // Closing the EventSource on the client closes the HTTP connection,
    // which fires cancel() on the server-side ReadableStream and aborts
    // the task. The server will send a task_error event we won't receive
    // (the connection is already closing), so we update UI immediately.
    if (currentEventSource) {
      currentEventSource.close();
      currentEventSource = null;
    }
    appendToChat(infoRow('⏹ stopped by user', 'error'));
    const chip = document.getElementById('status-chip');
    if (chip) {
      chip.className = 'status-chip error';
      chip.textContent = 'Stopped';
    }
    resetRunButton();
  }

  function resetRunButton() {
    const btn = document.getElementById('run-btn');
    if (!btn) return;
    btn.classList.remove('stop');
    btn.textContent = '▶ Run task';
    if (currentRunTaskName) {
      const name = currentRunTaskName;
      btn.onclick = () => startRun(name);
    }
  }

  function appendToChat(html) {
    const chat = document.getElementById('live-chat');
    if (!chat) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    while (wrapper.firstChild) chat.appendChild(wrapper.firstChild);
    chat.scrollTop = chat.scrollHeight;
  }

  function infoRow(text, cls) {
    return '<div class="event-row ' + (cls || '') + '">' + esc(text) + '</div>';
  }

  function handleLiveEvent(ev) {
    switch (ev.type) {
      case 'task_start':
        appendToChat(infoRow('▸ task start: ' + ev.task.name, 'info'));
        break;
      case 'setup_start':
        appendToChat(infoRow('⚙ running setup...', 'info'));
        break;
      case 'setup_done':
        appendToChat(infoRow('✓ setup done', 'success'));
        break;
      case 'setup_error':
        appendToChat(infoRow('✗ setup failed: ' + ev.error, 'error'));
        break;
      case 'repl_booting':
        appendToChat(infoRow('◐ spawning mini-claude subprocess...', 'info'));
        break;
      case 'repl_ready':
        appendToChat(infoRow('● mini-claude ready', 'success'));
        break;
      case 'user_message':
        appendToChat(
          '<div class="msg msg-user" style="margin-top:12px;">' +
          '<div class="msg-label">👤 Evaluator (turn ' + ev.turnNum + ')</div>' +
          '<div class="msg-bubble">' + esc(ev.message) + '</div>' +
          '</div>'
        );
        break;
      case 'agent_output':
        if (ev.output && ev.output.trim()) {
          appendToChat(
            '<div class="msg msg-agent">' +
            '<div class="msg-label">🤖 mini-claude</div>' +
            '<div class="msg-bubble"><pre>' + esc(ev.output.trim()) + '</pre></div>' +
            '</div>'
          );
        }
        break;
      case 'permission_prompt':
        appendToChat(infoRow('⚠ mini-claude is asking for permission...', 'warn'));
        break;
      case 'evaluator_thinking':
        appendToChat(infoRow('💭 evaluator is thinking: ' + ev.reason + ' (this can take 5-20s)', 'info'));
        break;
      case 'permission_decision': {
        const cls = ev.action === 'approve' ? 'approve' : 'deny';
        const label = ev.action === 'approve' ? '✓ APPROVED' : '✗ DENIED';
        let body = '<div style="font-weight:700; font-size:12px; margin-bottom:4px;">⚠ Permission ' + label + '</div>';
        body += '<div style="font-size:13px; line-height:1.5; font-style:italic;">💭 ' + esc(ev.thinking) + '</div>';
        if (ev.why) body += '<div style="font-size:13px; margin-top:4px;">' + esc(ev.why) + '</div>';
        appendToChat(
          '<div class="msg msg-permission ' + cls + '">' +
          '<div class="msg-label">Permission prompt</div>' +
          '<div class="msg-bubble">' + body + '</div>' +
          '</div>'
        );
        break;
      }
      case 'permission_answer_sent':
        appendToChat(infoRow('→ answered: ' + ev.answer, 'info'));
        break;
      case 'evaluator_decision': {
        let body = esc(ev.thinking || '');
        if (ev.action === 'goal_met') {
          body += '<div class="verdict-line pass">✓ Goal met' + (ev.summary ? ' — ' + esc(ev.summary) : '') + '</div>';
        } else if (ev.action === 'give_up') {
          body += '<div class="verdict-line give-up">✗ Gave up' + (ev.reason ? ' — ' + esc(ev.reason) : '') + '</div>';
        } else if (ev.action === 'send_message') {
          body += '<div class="verdict-line continue">➜ Replying to continue the conversation</div>';
        }
        appendToChat(
          '<div class="msg msg-evaluator">' +
          '<div class="msg-label">💭 Evaluator thinking</div>' +
          '<div class="msg-bubble">' + body + '</div>' +
          '</div>'
        );
        break;
      }
      case 'task_timeout':
        appendToChat(infoRow('⏱ timeout: ' + ev.message, 'error'));
        break;
      case 'task_error':
        appendToChat(infoRow('✗ error: ' + ev.error, 'error'));
        break;
      case 'task_done': {
        const r = ev.result;
        const chip = document.getElementById('status-chip');
        if (r.outcome === 'goal_met') {
          chip.className = 'status-chip done-pass';
          chip.textContent = '✓ Goal met';
        } else if (r.outcome === 'error') {
          chip.className = 'status-chip done-fail';
          chip.textContent = '✗ Error';
        } else {
          chip.className = 'status-chip done-other';
          chip.textContent = r.outcome.replace(/_/g, ' ');
        }
        appendToChat(infoRow('── task finished in ' + (r.totalWallMs / 1000).toFixed(1) + 's · ' + r.turns.length + ' turns ──', 'info'));
        break;
      }
    }
  }

  async function loadSidebar() {
    const res = await fetch('/api/runs');
    const runs = await res.json();
    const el = document.getElementById('sidebar-content');
    if (runs.length === 0) {
      el.innerHTML = '<div class="empty-sidebar">No runs yet.<br>Run <code>bun run eval/runner.ts</code> first.</div>';
      return;
    }
    el.innerHTML = runs.map(r => {
      const parts = [];
      if (r.passed > 0) parts.push('<span class="mini-stat pass">' + r.passed + ' pass</span>');
      if (r.failed > 0) parts.push('<span class="mini-stat fail">' + r.failed + ' fail</span>');
      if (r.errors > 0) parts.push('<span class="mini-stat err">' + r.errors + ' err</span>');
      return \`<div class="run-item" data-file="\${esc(r.file)}" onclick="selectRun('\${esc(r.file)}')">
        <div class="run-item-name">\${esc(r.timestamp)}</div>
        <div class="run-item-meta">
          \${parts.join(' ')}
          <span style="margin-left:auto;">\${esc(r.model || '')}</span>
        </div>
      </div>\`;
    }).join('');
  }

  async function selectRun(file) {
    document.querySelectorAll('.run-item').forEach(el => el.classList.toggle('active', el.dataset.file === file));
    const panel = document.getElementById('main-panel');
    panel.innerHTML = '<div class="loading">Loading run…</div>';
    const res = await fetch('/api/runs/' + encodeURIComponent(file));
    if (!res.ok) { panel.innerHTML = '<div class="placeholder"><h2>Error loading run</h2></div>'; return; }
    const events = await res.json();
    panel.innerHTML = renderRun(events);
  }

  function renderRun(events) {
    const runStart = events.find(e => e.type === 'run_start');
    const taskResults = events.filter(e => e.type === 'task_result');

    const totalTasks = taskResults.length;
    const goalsMet = taskResults.filter(t => t.outcome === 'goal_met').length;
    const totalTurns = taskResults.reduce((s, t) => s + (t.turns?.length || 0), 0);
    const totalMs = taskResults.reduce((s, t) => s + (t.wallMs || 0), 0);

    let html = '';

    if (runStart) {
      html += '<div class="meta-bar">';
      html += '<div class="meta-chip"><strong>' + esc(runStart.timestamp?.slice(0,19).replace('T',' ') ?? '') + '</strong></div>';
      html += '<div class="meta-chip">evaluator: <strong>' + esc(runStart.evaluatorModel || '') + '</strong></div>';
      html += '<div class="meta-chip"><strong>' + totalTasks + '</strong> task' + (totalTasks === 1 ? '' : 's') + '</div>';
      html += '</div>';
    }

    const passColor = goalsMet === totalTasks ? 'var(--green)' : 'var(--amber)';
    html += '<div class="score-grid">';
    html += '<div class="score-card"><div class="score-label">Goals met</div><div class="score-value" style="color:' + passColor + '">' + goalsMet + '/' + totalTasks + '</div><div class="score-sub">tasks successful</div></div>';
    html += '<div class="score-card"><div class="score-label">Turns</div><div class="score-value">' + totalTurns + '</div><div class="score-sub">total conversation turns</div></div>';
    html += '<div class="score-card"><div class="score-label">Wall time</div><div class="score-value">' + (totalMs/1000).toFixed(1) + '<span style="font-size:14px; color:var(--muted);">s</span></div><div class="score-sub">including evaluator calls</div></div>';
    html += '</div>';

    html += '<section><h2 class="section">Tasks</h2>';
    for (const t of taskResults) html += renderTaskCard(t);
    html += '</section>';

    return html;
  }

  function renderTaskCard(t) {
    const outcomeClass = t.outcome === 'goal_met' ? 'pass' : 'fail';
    const outcomeLabel = (t.outcome || 'unknown').replace(/_/g, ' ');
    const permCount = (t.turns || []).filter(tt => tt.permissionDecision).length;
    const turnCount = (t.turns || []).length;

    let html = '<div class="task-card" style="padding:24px;">';

    // Header
    html += '<div style="display:flex; align-items:flex-start; gap:12px; margin-bottom:20px;">';
    html += '<div style="flex:1;">';
    html += '<div style="font-size:13px; color:var(--muted); margin-bottom:4px;">' + turnCount + ' turn' + (turnCount === 1 ? '' : 's');
    if (permCount > 0) html += ' · ' + permCount + ' permission prompt' + (permCount === 1 ? '' : 's');
    html += ' · ' + ((t.wallMs ?? 0)/1000).toFixed(1) + 's</div>';
    html += '<div style="font-size:18px; font-weight:700; line-height:1.4;">' + esc(t.goal) + '</div>';
    html += '</div>';
    html += '<div class="verdict-badge ' + outcomeClass + '" style="font-size:13px; padding:5px 14px; flex-shrink:0;">' + esc(outcomeLabel) + '</div>';
    html += '</div>';

    // Details table
    html += '<table style="width:100%; margin-bottom:20px; border-collapse:collapse;">';
    html += '<tr><td style="font-size:14px; color:var(--muted); padding:6px 16px 6px 0; vertical-align:top; white-space:nowrap; width:90px;">Task</td>';
    html += '<td style="font-size:14px; padding:6px 0;"><code style="font-size:13px; background:var(--bg); padding:2px 8px; border-radius:4px;">' + esc(t.task) + '</code></td></tr>';
    if (t.openingMessage) {
      html += '<tr><td style="font-size:14px; color:var(--muted); padding:6px 16px 6px 0; vertical-align:top;">Message</td>';
      html += '<td style="font-size:14px; padding:6px 0;">"' + esc(t.openingMessage) + '"</td></tr>';
    }
    if (t.setupDescription) {
      html += '<tr><td style="font-size:14px; color:var(--muted); padding:6px 16px 6px 0; vertical-align:top;">Setup</td>';
      html += '<td style="font-size:14px; padding:6px 0;">' + esc(t.setupDescription) + '</td></tr>';
    }
    if (t.persona) {
      html += '<tr><td style="font-size:14px; color:var(--muted); padding:6px 16px 6px 0; vertical-align:top;">Persona</td>';
      html += '<td style="font-size:14px; padding:6px 0;">' + esc(t.persona) + '</td></tr>';
    }
    html += '</table>';

    // Success criteria
    if (t.successCriteria?.length) {
      html += '<div style="margin-bottom:20px;">';
      html += '<div style="font-size:13px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">Success criteria</div>';
      for (const c of t.successCriteria) {
        html += '<div style="font-size:14px; line-height:1.6; padding-left:16px; position:relative;">';
        html += '<span style="position:absolute; left:0; color:var(--muted);">·</span>' + esc(c);
        html += '</div>';
      }
      html += '</div>';
    }

    // Evaluator verdict
    if (t.finalSummary) {
      html += '<div style="font-size:14px; line-height:1.6; padding:14px 16px; background:var(--green-bg); border:1px solid var(--green-border); border-radius:10px; margin-bottom:16px; color:var(--green-text);">';
      html += '<div style="font-size:13px; font-weight:700; margin-bottom:4px;">EVALUATOR VERDICT</div>';
      html += esc(t.finalSummary);
      html += '</div>';
    }
    if (t.giveUpReason) {
      html += '<div style="font-size:14px; line-height:1.6; padding:14px 16px; background:var(--amber-bg); border:1px solid var(--amber); border-radius:10px; margin-bottom:16px; color:var(--amber-text);">';
      html += '<div style="font-size:13px; font-weight:700; margin-bottom:4px;">EVALUATOR VERDICT</div>';
      html += 'Gave up: ' + esc(t.giveUpReason);
      html += '</div>';
    }
    if (t.errorMessage) {
      html += '<div style="font-size:14px; line-height:1.6; padding:14px 16px; background:var(--red-bg); border:1px solid var(--red-border); border-radius:10px; margin-bottom:16px; color:var(--red-text);">';
      html += '<div style="font-size:13px; font-weight:700; margin-bottom:4px;">ERROR</div>';
      html += esc(t.errorMessage);
      html += '</div>';
    }

    // Conversation turns (collapsible)
    html += '<details><summary style="font-size:13px;">Conversation (' + turnCount + ' turn' + (turnCount === 1 ? '' : 's') + ')</summary>';
    html += renderConversation(t);
    html += '</details>';

    html += '</div>';
    return html;
  }

  function renderConversation(t) {
    const turns = t.turns || [];
    if (!turns.length) {
      return '<div style="color:var(--muted); font-style:italic; padding:12px;">no turns recorded</div>';
    }

    // Unique ID for this conversation's replay controls
    const chatId = 'chat-' + (t.task || '') + '-' + Math.random().toString(36).slice(2, 8);

    const messages = []; // flat list of message HTML strings, in chronological order
    let userMsg = t.openingMessage || '';

    for (const turn of turns) {
      // 1. Evaluator message (playing the user)
      if (userMsg) {
        messages.push(
          '<div class="msg msg-user">' +
          '<div class="msg-label">👤 Evaluator</div>' +
          '<div class="msg-bubble">' + esc(userMsg) + '</div>' +
          '</div>'
        );
      }

      // 2. mini-claude response
      if (turn.rawOutput && turn.rawOutput.trim()) {
        messages.push(
          '<div class="msg msg-agent">' +
          '<div class="msg-label">🤖 mini-claude</div>' +
          '<div class="msg-bubble"><pre>' + esc(turn.rawOutput.trim()) + '</pre></div>' +
          '</div>'
        );
      }

      // 3. Permission prompt + decision (if any)
      if (turn.permissionDecision) {
        const pd = turn.permissionDecision;
        const approved = pd.action === 'approve';
        const label = approved ? '✓ APPROVED' : '✗ DENIED';
        const cls = approved ? 'approve' : 'deny';
        let body = '<div style="font-weight:700; font-size:12px; margin-bottom:4px;">⚠ Permission ' + label + '</div>';
        body += '<div style="font-size:13px; line-height:1.5; font-style:italic;">💭 ' + esc(pd.thinking) + '</div>';
        if (pd.why) body += '<div style="font-size:13px; margin-top:4px;">' + esc(pd.why) + '</div>';
        messages.push(
          '<div class="msg msg-permission ' + cls + '">' +
          '<div class="msg-label">Permission prompt</div>' +
          '<div class="msg-bubble">' + body + '</div>' +
          '</div>'
        );
      }

      // 4. Evaluator decision (thinking + verdict)
      if (turn.evaluatorDecision) {
        const d = turn.evaluatorDecision;
        let body = esc(d.thinking || '');
        if (d.action === 'goal_met') {
          body += '<div class="verdict-line pass">✓ Goal met' + (d.summary ? ' — ' + esc(d.summary) : '') + '</div>';
        } else if (d.action === 'give_up') {
          body += '<div class="verdict-line give-up">✗ Gave up' + (d.reason ? ' — ' + esc(d.reason) : '') + '</div>';
        } else if (d.action === 'send_message') {
          body += '<div class="verdict-line continue">➜ Replying to continue the conversation</div>';
        }
        messages.push(
          '<div class="msg msg-evaluator">' +
          '<div class="msg-label">💭 Evaluator thinking</div>' +
          '<div class="msg-bubble">' + body + '</div>' +
          '</div>'
        );
        // Prepare next turn's user message
        userMsg = d.action === 'send_message' ? (d.message || '') : '';
      } else {
        userMsg = '';
      }
    }

    // Wrap in chat container with replay controls
    let html = '<div class="chat" id="' + chatId + '">';
    html += '<div class="chat-controls">';
    html += '<button class="chat-btn" onclick="replayChat(\\'' + chatId + '\\')">▶ Replay turn by turn</button>';
    html += '<button class="chat-btn" onclick="showAllChat(\\'' + chatId + '\\')">⏭ Show all</button>';
    html += '<span style="color:var(--muted); font-size:12px; padding:6px 4px;">' + messages.length + ' messages · ' + turns.length + ' turn' + (turns.length === 1 ? '' : 's') + '</span>';
    html += '</div>';
    html += '<div class="chat-messages">' + messages.join('') + '</div>';
    html += '</div>';
    return html;
  }

  // ── Replay controls ──────────────────────────────────────────────────────

  const REPLAY_DELAY_MS = 900; // per message
  const replayTimers = new Map(); // chatId -> timeouts

  function clearReplay(chatId) {
    const timers = replayTimers.get(chatId) || [];
    for (const t of timers) clearTimeout(t);
    replayTimers.set(chatId, []);
  }

  function replayChat(chatId) {
    const chat = document.getElementById(chatId);
    if (!chat) return;
    clearReplay(chatId);
    const msgs = chat.querySelectorAll('.msg');
    const btn = chat.querySelector('.chat-btn');
    if (btn) {
      btn.classList.add('playing');
      btn.textContent = '⏸ Playing...';
    }
    // Hide all messages
    for (const m of msgs) {
      m.classList.add('playback-hidden');
      m.style.animation = 'none';
    }
    // Reveal one at a time
    const timers = [];
    for (let i = 0; i < msgs.length; i++) {
      const t = setTimeout(() => {
        msgs[i].classList.remove('playback-hidden');
        // Re-trigger the fadeIn animation
        msgs[i].style.animation = 'none';
        // Force reflow
        void msgs[i].offsetWidth;
        msgs[i].style.animation = 'fadeIn 0.3s ease-out forwards';
        // Scroll the chat to the new message
        chat.scrollTop = chat.scrollHeight;
        if (i === msgs.length - 1 && btn) {
          btn.classList.remove('playing');
          btn.textContent = '▶ Replay turn by turn';
        }
      }, i * REPLAY_DELAY_MS);
      timers.push(t);
    }
    replayTimers.set(chatId, timers);
  }

  function showAllChat(chatId) {
    const chat = document.getElementById(chatId);
    if (!chat) return;
    clearReplay(chatId);
    const btn = chat.querySelector('.chat-btn');
    if (btn) {
      btn.classList.remove('playing');
      btn.textContent = '▶ Replay turn by turn';
    }
    const msgs = chat.querySelectorAll('.msg');
    for (const m of msgs) {
      m.classList.remove('playback-hidden');
      m.style.animation = 'none';
    }
  }

  // Expose to inline onclick handlers
  window.replayChat = replayChat;
  window.showAllChat = showAllChat;
  window.switchTab = switchTab;
  window.selectTask = selectTask;
  window.startRun = startRun;
  window.stopRun = stopRun;

  // Initial load: tasks tab is active by default
  loadTaskSidebar();
</script>
</body>
</html>`

// ── HTTP server ──────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(INDEX_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    if (url.pathname === '/api/runs' && req.method === 'GET') {
      return Response.json(await listRuns())
    }

    const match = url.pathname.match(/^\/api\/runs\/(.+)$/)
    if (match && req.method === 'GET') {
      const file = decodeURIComponent(match[1]!)
      if (file.includes('..') || file.includes('/')) {
        return new Response('Bad request', { status: 400 })
      }
      const data = await getRun(file)
      if (!data) return new Response('Not found', { status: 404 })
      return Response.json(data)
    }

    // List all available tasks (from tasks.ts)
    if (url.pathname === '/api/tasks' && req.method === 'GET') {
      // Strip setup/cleanup functions since they can't be serialized
      const tasks = TASKS.map(t => ({
        name: t.name,
        goal: t.goal,
        successCriteria: t.successCriteria,
        persona: t.persona,
        maxTurns: t.maxTurns,
      }))
      return Response.json(tasks)
    }

    // Live task execution via Server-Sent Events
    const runMatch = url.pathname.match(/^\/api\/run\/(.+)$/)
    if (runMatch && req.method === 'GET') {
      const taskName = decodeURIComponent(runMatch[1]!)
      const task = TASKS.find(t => t.name === taskName)
      if (!task) return new Response('Task not found', { status: 404 })

      // Client disconnect (Stop button closes EventSource) triggers cancel(),
      // which aborts the controller so runTaskStream unwinds cleanly.
      const abortController = new AbortController()
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder()
          const send = (event: object): void => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
          }
          // Keepalive: emit an SSE comment every 2s so the connection stays
          // warm and proxies/browsers don't buffer or time out during slow
          // evaluator calls.
          const keepalive = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`: keepalive\n\n`))
            } catch { /* stream closed */ }
          }, 2000)
          try {
            for await (const ev of runTaskStream(task, { signal: abortController.signal })) {
              send(ev)
            }
          } catch (err) {
            send({ type: 'task_error', error: err instanceof Error ? err.message : String(err) })
          } finally {
            clearInterval(keepalive)
            try { controller.close() } catch { /* already closed */ }
          }
        },
        cancel() {
          abortController.abort()
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      })
    }

    return new Response('Not found', { status: 404 })
  },
})

console.log(`mini-claude Eval Portal running at http://localhost:${server.port}`)
console.log(`Press Ctrl+C to stop.`)
