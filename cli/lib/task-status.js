'use strict';

var fs = require('fs');
var path = require('path');
var agent = require('./agent');
var config = require('./config');
var git = require('./git');
var prompts = require('./prompts');

var TASK_STATUSES = ['todo', 'doing', 'review', 'done'];
var STATUS_RANK = {
  todo: 0,
  doing: 1,
  review: 2,
  done: 3
};
var DIFF_LIMIT = 120000;

function updateForStagedCommit(root, options) {
  options = options || {};
  var repoRoot = git.repoRoot(root);
  if (process.env.GMC_SKIP_TASK_STATUS === '1') {
    return noUpdates();
  }
  if (!git.hasStagedDiff(repoRoot)) {
    return noUpdates();
  }

  var tasks = readRepositoryTasks(repoRoot);
  if (!tasks.length) {
    return noUpdates();
  }

  var diff = options.diff || git.stagedDiff(repoRoot);
  if (!diff.trim()) {
    return noUpdates();
  }
  if (diff.length > DIFF_LIMIT) {
    diff = diff.slice(0, DIFF_LIMIT) + '\n\n[Diff truncated by gmc]\n';
  }

  var selectedAgent = options.agent || currentAgent(repoRoot);
  var prompt = prompts.taskStatusPrompt(tasks.map(taskForPrompt), diff, git.statusShort(repoRoot));
  var text = agent.generateText(prompt, repoRoot, selectedAgent, {
    outputPrefix: 'gmc-task-status',
    description: 'task status generation'
  });
  var decisions = parseDecision(text);
  var applied = applyDecisions(repoRoot, tasks, decisions);
  if (applied.paths.length) {
    git.runGit(['add', '-A', '--'].concat(applied.paths), { cwd: repoRoot });
  }
  return applied;
}

function currentAgent(repoRoot) {
  var binding = config.readBinding(repoRoot);
  return binding && binding.agent ? binding.agent : config.currentAgent();
}

function noUpdates() {
  return {
    updates: [],
    paths: []
  };
}

function taskForPrompt(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    content: task.content
  };
}

function parseDecision(text) {
  var jsonText = extractJson(text);
  var parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error('Could not parse task status AI response as JSON: ' + firstLine(text));
  }
  if (!parsed || !Array.isArray(parsed.updates)) {
    throw new Error('Task status AI response must contain an updates array.');
  }
  return parsed.updates;
}

function extractJson(text) {
  text = String(text || '').trim();
  var fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced) {
    text = fenced[1].trim();
  }
  var start = text.indexOf('{');
  var end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
  return text;
}

function applyDecisions(repoRoot, tasks, decisions) {
  var byId = {};
  tasks.forEach(function (task) {
    byId[task.id] = task;
  });

  var now = new Date().toISOString();
  var updates = [];
  var paths = [];
  decisions.forEach(function (decision) {
    if (!decision || typeof decision !== 'object') {
      return;
    }
    var id = normalizeTaskId(decision.id);
    var nextStatus = normalizeTaskStatus(decision.status);
    var task = byId[id];
    if (!task || !nextStatus || task.status === nextStatus) {
      return;
    }
    if (STATUS_RANK[nextStatus] < STATUS_RANK[task.status]) {
      return;
    }

    task.status = nextStatus;
    task.updated = now;
    writeRepositoryTask(repoRoot, task);
    updates.push({
      id: task.id,
      status: task.status,
      reason: String(decision.reason || '').trim()
    });
    paths.push(task.path);
  });

  return {
    updates: updates,
    paths: unique(paths)
  };
}

function readRepositoryTasks(repoRoot) {
  var dir = repositoryTasksDir(repoRoot);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir)
    .filter(function (name) { return /\.md$/i.test(name); })
    .map(function (name) {
      return readRepositoryTaskFile(repoRoot, path.join(dir, name));
    })
    .filter(Boolean);
}

function readRepositoryTaskFile(repoRoot, filePath) {
  if (!isPathInside(repositoryTasksDir(repoRoot), filePath)) return null;
  var raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }

  var parsed = parseTaskMarkdown(raw);
  var id = normalizeTaskId(parsed.meta.id) || normalizeTaskId(path.basename(filePath, '.md'));
  if (!id) return null;
  return {
    id: id,
    title: String(parsed.meta.title || firstMarkdownHeading(parsed.content) || id).trim().slice(0, 160),
    status: normalizeTaskStatus(parsed.meta.status || 'todo') || 'todo',
    created: String(parsed.meta.created || ''),
    updated: String(parsed.meta.updated || parsed.meta.created || ''),
    content: parsed.content.trim(),
    path: path.relative(repoRoot, filePath)
  };
}

function writeRepositoryTask(repoRoot, task) {
  var dir = repositoryTasksDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  var filePath = path.join(dir, normalizeTaskId(task.id) + '.md');
  if (!isPathInside(dir, filePath)) {
    throw new Error('Invalid task id: ' + task.id);
  }
  fs.writeFileSync(filePath, taskMarkdown(task));
}

function taskMarkdown(task) {
  return [
    '---',
    'id: ' + task.id,
    'title: ' + JSON.stringify(task.title || task.id),
    'status: ' + (normalizeTaskStatus(task.status) || 'todo'),
    'created: ' + JSON.stringify(task.created || new Date().toISOString()),
    'updated: ' + JSON.stringify(task.updated || task.created || new Date().toISOString()),
    '---',
    '',
    String(task.content || '').trim(),
    ''
  ].join('\n');
}

function parseTaskMarkdown(raw) {
  var text = String(raw || '');
  var match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) {
    return { meta: {}, content: text };
  }
  var meta = {};
  match[1].split(/\r?\n/).forEach(function (line) {
    var item = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!item) return;
    meta[item[1]] = parseTaskScalar(item[2]);
  });
  return {
    meta: meta,
    content: text.slice(match[0].length)
  };
}

function parseTaskScalar(value) {
  value = String(value || '').trim();
  if (!value) return '';
  if ((value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') ||
      (value.charAt(0) === '[' && value.charAt(value.length - 1) === ']')) {
    try {
      return JSON.parse(value);
    } catch (e) { /* fall back */ }
  }
  return value;
}

function firstMarkdownHeading(content) {
  var lines = String(content || '').split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var match = /^#\s+(.+)$/.exec(lines[i].trim());
    if (match) return match[1];
  }
  return '';
}

function repositoryTasksDir(repoRoot) {
  return path.join(repoRoot, '.gmc', 'tasks');
}

function normalizeTaskId(value) {
  var id = String(value || '').trim().toUpperCase();
  return /^GMC-\d{4,}$/.test(id) ? id : '';
}

function normalizeTaskStatus(value) {
  value = String(value || '').trim().toLowerCase();
  return TASK_STATUSES.indexOf(value) >= 0 ? value : '';
}

function isPathInside(parent, child) {
  var relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!!relative && relative.indexOf('..') !== 0 && !path.isAbsolute(relative));
}

function unique(values) {
  var result = [];
  values.forEach(function (value) {
    if (value && result.indexOf(value) < 0) {
      result.push(value);
    }
  });
  return result;
}

function firstLine(value) {
  return String(value || '').trim().split(/\r?\n/)[0] || '(empty)';
}

module.exports = {
  updateForStagedCommit: updateForStagedCommit,
  readRepositoryTasks: readRepositoryTasks
};
