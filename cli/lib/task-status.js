'use strict';

var fs = require('fs');
var path = require('path');
var git = require('./git');

var TASK_STATUSES = ['todo', 'doing', 'review', 'done'];
var STATUS_RANK = {
  todo: 0,
  doing: 1,
  review: 2,
  done: 3
};

function taskForPrompt(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    content: task.content
  };
}

function readUnfinishedTasksForPrompt(root) {
  var repoRoot = git.repoRoot(root);
  return readRepositoryTasks(repoRoot)
    .filter(function (task) { return task.status !== 'done'; })
    .map(taskForPrompt);
}

function parseCommitPlan(text) {
  var jsonText = extractJson(text);
  var parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error('Could not parse AI commit plan as JSON: ' + firstLine(text));
  }
  if (!parsed || typeof parsed.message !== 'string' || !Array.isArray(parsed.taskUpdates)) {
    throw new Error('AI commit plan must contain message and taskUpdates.');
  }
  return {
    message: parsed.message,
    taskUpdates: parsed.taskUpdates
  };
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

function applyUpdates(root, decisions) {
  var repoRoot = git.repoRoot(root);
  return applyDecisions(repoRoot, readRepositoryTasks(repoRoot), decisions || []);
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
  applyUpdates: applyUpdates,
  parseCommitPlan: parseCommitPlan,
  readRepositoryTasks: readRepositoryTasks,
  readUnfinishedTasksForPrompt: readUnfinishedTasksForPrompt,
  taskForPrompt: taskForPrompt
};
