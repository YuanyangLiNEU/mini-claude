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
  </style>
</head>
<body>
<header>
  <div class="logo">mini<span>·</span>claude</div>
  <span class="badge">Eval Portal</span>
</header>

<div class="layout">
  <aside>
    <div class="sidebar-title">Runs</div>
    <div id="sidebar-content"><div class="loading">Loading…</div></div>
  </aside>
  <main id="main-panel">
    <div class="placeholder">
      <div class="placeholder-icon">◈</div>
      <h2>Select a run</h2>
      <p>Pick an eval run from the sidebar to see per-task verdicts, trajectories, and judge reasoning.</p>
      <code>bun run eval/runner.ts</code>
    </div>
  </main>
</div>

<script>
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

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
    const totalTurns = taskResults.reduce((s, t) => s + (t.metrics?.conversationTurns || 0), 0);
    const totalIn = taskResults.reduce((s, t) => s + (t.metrics?.miniClaudeInputTokens || 0), 0);
    const totalOut = taskResults.reduce((s, t) => s + (t.metrics?.miniClaudeOutputTokens || 0), 0);
    const totalMs = taskResults.reduce((s, t) => s + (t.metrics?.wallMs || 0), 0);

    let html = '';

    if (runStart) {
      html += '<div class="meta-bar">';
      html += '<div class="meta-chip"><strong>' + esc(runStart.timestamp?.slice(0,19).replace('T',' ') ?? '') + '</strong></div>';
      html += '<div class="meta-chip">mini-claude: <strong>' + esc(runStart.model) + '</strong></div>';
      html += '<div class="meta-chip">evaluator: <strong>' + esc(runStart.evaluatorModel || runStart.judgeModel) + '</strong></div>';
      html += '<div class="meta-chip"><strong>' + totalTasks + '</strong> task' + (totalTasks === 1 ? '' : 's') + '</div>';
      html += '</div>';
    }

    const passColor = goalsMet === totalTasks ? 'var(--green)' : 'var(--amber)';
    html += '<div class="score-grid">';
    html += '<div class="score-card"><div class="score-label">Goals met</div><div class="score-value" style="color:' + passColor + '">' + goalsMet + '/' + totalTasks + '</div><div class="score-sub">tasks successful</div></div>';
    html += '<div class="score-card"><div class="score-label">Conversation</div><div class="score-value">' + totalTurns + '</div><div class="score-sub">turns total</div></div>';
    html += '<div class="score-card"><div class="score-label">Tokens</div><div class="score-value" style="font-size:22px;">' + (totalIn/1000).toFixed(1) + 'k<span style="font-size:14px; color:var(--muted);"> in</span></div><div class="score-sub">' + totalOut + ' output (mini-claude only)</div></div>';
    html += '<div class="score-card"><div class="score-label">Wall time</div><div class="score-value">' + (totalMs/1000).toFixed(1) + '<span style="font-size:14px; color:var(--muted);">s</span></div><div class="score-sub">conversation + evaluator</div></div>';
    html += '</div>';

    html += '<section><h2 class="section">Tasks</h2>';
    for (const t of taskResults) html += renderTaskCard(t);
    html += '</section>';

    return html;
  }

  function renderTaskCard(t) {
    const outcomeClass = t.outcome === 'goal_met' ? 'pass' : 'fail';
    const outcomeLabel = (t.outcome || 'unknown').replace(/_/g, ' ');

    let html = '<div class="task-card">';
    html += '<div class="task-header">';
    html += '<div class="task-name">' + esc(t.task) + '</div>';
    html += '<div class="verdict-badge ' + outcomeClass + '">' + esc(outcomeLabel) + '</div>';
    html += '</div>';

    const permCount = (t.turns || []).filter(tt => tt.permissionEvent).length;
    html += '<div class="task-meta">';
    html += '<span><strong>' + (t.metrics?.conversationTurns ?? '?') + '</strong> turns</span>';
    if (permCount > 0) {
      html += '<span><strong>' + permCount + '</strong> permission prompt' + (permCount === 1 ? '' : 's') + '</span>';
    }
    html += '<span><strong>' + (t.metrics?.miniClaudeInputTokens ?? 0) + '</strong> in</span>';
    html += '<span><strong>' + (t.metrics?.miniClaudeOutputTokens ?? 0) + '</strong> out</span>';
    html += '<span><strong>' + ((t.metrics?.wallMs ?? 0)/1000).toFixed(1) + 's</strong></span>';
    html += '</div>';

    html += '<div class="task-goal">' + esc(t.goal) + '</div>';

    // Setup + persona (environment the evaluator operates in)
    if (t.setupDescription) {
      html += '<div style="font-size:11px; color:var(--muted); margin-bottom:8px; padding:6px 10px; background:var(--bg); border-radius:6px;"><strong>setup:</strong> ' + esc(t.setupDescription) + '</div>';
    }
    if (t.persona) {
      html += '<div style="font-size:11px; color:var(--muted); margin-bottom:8px; padding:6px 10px; background:var(--bg); border-radius:6px;"><strong>persona:</strong> ' + esc(t.persona) + '</div>';
    }

    // Success criteria
    if (t.successCriteria?.length) {
      html += '<div class="expectations"><ul class="exp-list">';
      for (const c of t.successCriteria) {
        html += '<li><span class="exp-mark" style="color:var(--muted);">·</span><span>' + esc(c) + '</span></li>';
      }
      html += '</ul></div>';
    }

    if (t.finalSummary) html += '<div class="reasoning">' + esc(t.finalSummary) + '</div>';
    if (t.giveUpReason) html += '<div class="reasoning" style="border-left-color:var(--amber);">Gave up: ' + esc(t.giveUpReason) + '</div>';
    if (t.errorMessage) html += '<div class="reasoning" style="border-left-color:var(--red);">Error: ' + esc(t.errorMessage) + '</div>';

    // Conversation turns
    html += '<details><summary>Conversation (' + (t.turns?.length || 0) + ' turns)</summary>';
    html += renderConversation(t);
    html += '</details>';

    html += '</div>';
    return html;
  }

  function renderConversation(t) {
    if (!t.turns?.length) return '<div class="tool-call-row" style="color:var(--muted); font-style:italic;">no turns</div>';
    let html = '';
    let userMsg = t.openingMessage;
    for (const turn of t.turns) {
      html += '<div style="margin-top:12px; padding-top:12px; border-top:1px solid var(--border);">';
      html += '<div style="font-size:11px; color:var(--muted); margin-bottom:8px;">TURN ' + turn.turnNum + '</div>';

      html += '<div style="margin-bottom:8px; padding:8px 10px; background:var(--sky-light); border-radius:8px; font-size:12px;">';
      html += '<strong style="color:var(--sky-text);">👤 user:</strong> ' + esc(userMsg);
      html += '</div>';

      // Render mini-claude actions in order. When we hit the tool_call that
      // triggered a permission event (matched by tool name + input), insert
      // the permission prompt/decision inline — that's where it chronologically
      // happens (the agent loop pauses there before tool_result arrives).
      const perm = turn.permissionEvent;
      const permInputStr = perm ? JSON.stringify(perm.toolInput) : '';
      let permInserted = false;

      for (const a of turn.miniClaudeActions || []) {
        if (a.type === 'text') {
          html += '<div style="padding:4px 10px; font-size:12px; line-height:1.5;">' + esc(a.text.replace(/\\n/g, ' ')) + '</div>';
        } else if (a.type === 'tool_call') {
          html += '<div class="tool-call-row"><span class="tool-call-name">→ ' + esc(a.name) + '</span>(' + esc(JSON.stringify(a.input).slice(0,200)) + ')</div>';
          // If this tool_call triggered the permission prompt, render it right after
          if (perm && !permInserted && a.name === perm.toolName && JSON.stringify(a.input) === permInputStr) {
            html += renderPermissionBlock(perm);
            permInserted = true;
          }
        } else if (a.type === 'tool_result') {
          const color = a.isError ? 'var(--red-text)' : 'var(--muted)';
          html += '<div class="tool-call-row" style="color:' + color + '; font-size:11px;">← ' + esc(a.result.replace(/\\n/g,' ').slice(0,200)) + '</div>';
        }
      }
      // Fallback: if we didn't match the tool call (shouldn't happen), render
      // the permission at the end so it's still visible.
      if (perm && !permInserted) html += renderPermissionBlock(perm);

      // Evaluator decision
      const d = turn.evaluatorDecision;
      if (d) {
        html += '<div style="margin-top:8px; padding:8px 10px; background:var(--bg); border-radius:8px; font-size:12px; border-left:3px solid var(--sky);">';
        html += '<div style="font-style:italic; color:var(--muted);">💭 ' + esc(d.thinking) + '</div>';
        if (d.action === 'goal_met') {
          html += '<div style="margin-top:4px; color:var(--green-text); font-weight:600;">✓ goal met — ' + esc(d.summary) + '</div>';
        } else if (d.action === 'give_up') {
          html += '<div style="margin-top:4px; color:var(--amber-text); font-weight:600;">✗ give up — ' + esc(d.reason) + '</div>';
        } else if (d.action === 'send_message') {
          html += '<div style="margin-top:4px; color:var(--sky-text);">➜ reply: "' + esc(d.message) + '"</div>';
        }
        html += '</div>';

        // Set up next user message for next turn
        if (d.action === 'send_message') userMsg = d.message;
      }

      html += '</div>';
    }
    return html;
  }

  function renderPermissionBlock(p) {
    const approved = p.decision === 'approve';
    const accent = approved ? 'var(--green)' : 'var(--red)';
    const bg = approved ? 'var(--green-bg)' : 'var(--red-bg)';
    const border = approved ? 'var(--green-border)' : 'var(--red-border)';
    const mark = approved ? '✓ APPROVED' : '✗ DENIED';
    let html = '<div style="margin:6px 0 6px 20px; padding:10px 12px; background:' + bg + '; border:1px solid ' + border + '; border-left:4px solid ' + accent + '; border-radius:8px; font-size:12px;">';
    html += '<div style="font-weight:700; color:' + accent + '; text-transform:uppercase; letter-spacing:0.4px; font-size:10px; margin-bottom:6px;">⚠ PERMISSION PROMPT</div>';
    html += '<div style="font-weight:600;">' + esc(p.toolName) + '(' + esc(JSON.stringify(p.toolInput).slice(0,160)) + ')</div>';
    html += '<div style="font-style:italic; color:var(--muted); margin-top:6px;">💭 user thinking: ' + esc(p.evaluatorThinking) + '</div>';
    html += '<div style="margin-top:6px; font-weight:700; color:' + accent + ';">' + mark + '</div>';
    if (p.evaluatorWhy) html += '<div style="margin-top:4px; color:var(--muted);">' + esc(p.evaluatorWhy) + '</div>';
    html += '</div>';
    return html;
  }

  loadSidebar();
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

    return new Response('Not found', { status: 404 })
  },
})

console.log(`mini-claude Eval Portal running at http://localhost:${server.port}`)
console.log(`Press Ctrl+C to stop.`)
