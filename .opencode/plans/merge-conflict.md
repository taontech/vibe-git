# 自动合并冲突解决 — 实现计划

## 概述

允许用户在 Web UI 中点击 conflict 文件 → 查看冲突详情 → 一键 AI 解决或手动编辑。

## 改动清单

### 1. 新增 `cli/lib/merge-conflict.js` — 核心逻辑

```javascript
'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');
var agent = require('./agent');
var config = require('./config');
var git = require('./git');
var prompts = require('./prompts');

var DIFF_LIMIT = 120000;

function inMerge(root) {
  var repoRoot = git.repoRoot(root);
  var mergeHead = path.join(git.gitDir(repoRoot), 'MERGE_HEAD');
  return fs.existsSync(mergeHead);
}

function getMergeBranches(root) {
  var repoRoot = git.repoRoot(root);
  var mergeHead = path.join(git.gitDir(repoRoot), 'MERGE_HEAD');
  if (!fs.existsSync(mergeHead)) { return null; }
  var mergeHeadOid = fs.readFileSync(mergeHead, 'utf8').trim();
  var branch = git.currentBranch(repoRoot);
  var mergeBranch = '';
  var mergeBranchResult = git.runGit(['name-rev', '--name-only', mergeHeadOid], {
    cwd: repoRoot, allowFailure: true
  });
  if (mergeBranchResult.status === 0 && mergeBranchResult.stdout) {
    mergeBranch = mergeBranchResult.stdout.trim();
  }
  if (!mergeBranch) { mergeBranch = mergeHeadOid.slice(0, 12); }
  return { branch: branch, mergeBranch: mergeBranch, mergeHeadOid: mergeHeadOid };
}

function listConflictedFiles(root) {
  var repoRoot = git.repoRoot(root);
  var output = git.runGit(['diff', '--name-only', '--diff-filter=U'], {
    cwd: repoRoot, allowFailure: true
  });
  if (output.status !== 0 || !output.stdout) { return []; }
  return output.stdout.trim().split(/\r?\n/).filter(Boolean);
}

function getOurs(root, filePath) { return gitShow(root, ':2:' + filePath); }
function getTheirs(root, filePath) { return gitShow(root, ':3:' + filePath); }
function getBase(root, filePath) { return gitShow(root, ':1:' + filePath); }

function gitShow(root, ref) {
  var result = childProcess.spawnSync('git', ['show', ref], {
    cwd: git.repoRoot(root), encoding: 'utf8', maxBuffer: DIFF_LIMIT + 1024
  });
  if (result.error || result.status !== 0) { return null; }
  return result.stdout;
}

function getConflictedContent(root, filePath) {
  var repoRoot = git.repoRoot(root);
  var fullPath = path.resolve(repoRoot, filePath);
  if (!fs.existsSync(fullPath)) { return null; }
  return fs.readFileSync(fullPath, 'utf8');
}

function getConflictDetail(root, filePath) {
  if (!inMerge(root)) { return null; }
  var ours = getOurs(root, filePath);
  var theirs = getTheirs(root, filePath);
  var base = getBase(root, filePath);
  var conflicted = getConflictedContent(root, filePath);
  var mergeInfo = getMergeBranches(root);
  return {
    ours: ours, theirs: theirs, base: base, conflicted: conflicted,
    branch: mergeInfo ? mergeInfo.branch : '',
    mergeBranch: mergeInfo ? mergeInfo.mergeBranch : ''
  };
}

function resolveFile(root, filePath) {
  var repoRoot = git.repoRoot(root);
  var detail = getConflictDetail(repoRoot, filePath);
  if (!detail) { throw new Error('Not in a merge state or file is not conflicted: ' + filePath); }
  var binding = config.readBinding(repoRoot);
  var selectedAgent = binding ? binding.agent : config.currentAgent();
  var prompt = prompts.mergeConflictPrompt({
    filePath: filePath, branch: detail.branch, mergeBranch: detail.mergeBranch,
    ours: detail.ours || '', theirs: detail.theirs || '',
    base: detail.base || '', conflicted: detail.conflicted || ''
  });
  var resolvedContent = agent.generateText(prompt, repoRoot, selectedAgent, {
    outputPrefix: 'gmc-merge-resolve', description: 'merge conflict resolution'
  });
  var fullPath = path.resolve(repoRoot, filePath);
  fs.writeFileSync(fullPath, resolvedContent, 'utf8');
  git.runGit(['add', '--', filePath], { cwd: repoRoot });
  return resolvedContent;
}

function validateResolution(filePath) {
  if (!fs.existsSync(filePath)) { return { valid: false, error: 'File not found: ' + filePath }; }
  var content = fs.readFileSync(filePath, 'utf8');
  var conflictPattern = /^<{7}|^={7}|^>{7}/m;
  if (conflictPattern.test(content)) { return { valid: false, error: 'File still contains conflict markers' }; }
  return { valid: true };
}

function isFullyResolved(root) {
  return listConflictedFiles(root).length === 0;
}

module.exports = {
  inMerge: inMerge, getMergeBranches: getMergeBranches,
  listConflictedFiles: listConflictedFiles, getConflictDetail: getConflictDetail,
  resolveFile: resolveFile, validateResolution: validateResolution,
  isFullyResolved: isFullyResolved
};
```

### 2. `cli/lib/prompts.js` — 新增 mergeConflictPrompt

在文件末尾 `module.exports` 之前添加：

```javascript
function mergeConflictPrompt(options) {
  return [
    'You are resolving a Git merge conflict.',
    '',
    'File: ' + options.filePath,
    'Current branch: ' + options.branch,
    'Merging branch: ' + options.mergeBranch,
    '',
    'Instructions:',
    '- Analyze the conflict below and produce a clean resolved file.',
    '- Use the base version (common ancestor) as context to understand what changed on each side.',
    '- Preserve the intent of changes from both sides when possible.',
    '- Remove ALL conflict markers (<<<<<<<, =======, >>>>>>>).',
    '- Keep the file syntactically valid.',
    '- When changes genuinely conflict, choose the correct side based on context.',
    '- Output ONLY the resolved file content. Do not use markdown, code fences, or explanation.',
    '',
    'Ours (HEAD):',
    '----------------------------------------',
    (options.ours || '(empty file)'),
    '',
    'Theirs (incoming):',
    '----------------------------------------',
    (options.theirs || '(empty file)'),
    '',
    'Base (common ancestor):',
    '----------------------------------------',
    (options.base || '(empty or no base)'),
    '',
    'Conflicted file (with markers):',
    '----------------------------------------',
    (options.conflicted || '(empty)')
  ].join('\n');
}
```

同时更新 `module.exports` 加入 `mergeConflictPrompt`。

### 3. `cli/lib/web.js` 服务器端

#### A. 修改 `fileDiff()` 函数（约 line 1748）

找到 `fileDiff` 函数，在 `repoRoot` 解析后添加 UU 检测分支。在现有逻辑之前，增加：

```javascript
function fileDiff(root, filePath) {
  var repoRoot = git.repoRoot(root);
  var cleanPath = normalizeRepositoryPath(filePath, false);
  var changedFiles = parseStatusOutput(runGitOptional(repoRoot, ['status', '--porcelain=v1', '-b', '-z'])).files;
  var file = changedFiles.find(function (item) { return item.path === cleanPath; });
  if (!file) { throwHttpError('File has no working tree changes: ' + cleanPath); }

  // --- MERGE CONFLICT DETECTION ---
  if (file.code === 'UU') {
    var mergeConflict = require('./merge-conflict');
    var detail = mergeConflict.getConflictDetail(repoRoot, cleanPath);
    var diffOutput = '';
    if (detail && detail.ours !== null && detail.theirs !== null) {
      // Show ours vs theirs as a diff
      var diffResult = childProcess.spawnSync('git', ['diff', '--no-color', '--', cleanPath], {
        cwd: repoRoot, encoding: 'utf8', maxBuffer: DIFF_LIMIT + 1024
      });
      diffOutput = diffResult.stdout || '';
      var truncated = diffOutput.length > DIFF_LIMIT;
      if (truncated) { diffOutput = diffOutput.slice(0, DIFF_LIMIT) + '\n\n[Diff truncated by gmc]\n'; }
      return {
        path: cleanPath, displayPath: file.displayPath || cleanPath,
        code: 'UU', diff: diffOutput, truncated: truncated,
        mergeConflict: true,
        mergeBranch: detail.mergeBranch
      };
    }
  }
  // --- END MERGE CONFLICT DETECTION ---

  // ... rest of existing fileDiff function
```

#### B. 新增 POST 端点：在 `handleRequest` 的 POST 区段（约 line 165-243）末尾、405 之前添加：

```javascript
if (parsed.pathname === '/api/merge/resolve-file') {
  handleMergeResolveFile(req, res, parsed.query.repo);
  return;
}
if (parsed.pathname === '/api/merge/accept-file') {
  handleMergeAcceptFile(req, res, parsed.query.repo);
  return;
}
```

#### C. 新增 handler 函数（在 handleRequest 之后，其他 handler 函数附近）：

```javascript
function handleMergeResolveFile(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  readJsonBody(req).then(function (body) {
    var filePath = body.path;
    if (!filePath) return sendJsonError(res, 400, 'Missing file path');
    var mergeConflict = require('./merge-conflict');
    var detail = mergeConflict.getConflictDetail(targetRepo, filePath);
    if (!detail) return sendJsonError(res, 400, 'File is not in a merge conflict');
    return detail;
  }).then(function (detail) {
    // Return conflict info without resolving yet — client decides
    sendJson(res, {
      ours: detail.ours, theirs: detail.theirs,
      base: detail.base, conflicted: detail.conflicted,
      branch: detail.branch, mergeBranch: detail.mergeBranch,
      path: filePath
    });
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
}

function handleMergeAcceptFile(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  readJsonBody(req).then(function (body) {
    var filePath = body.path;
    if (!filePath) return sendJsonError(res, 400, 'Missing file path');
    var mergeConflict = require('./merge-conflict');
    mergeConflict.resolveFile(targetRepo, filePath);
    var valid = mergeConflict.validateResolution(path.join(git.repoRoot(targetRepo), filePath));
    if (!valid.valid) return sendJsonError(res, 400, valid.error);
    return { status: 'ok', path: filePath };
  }).then(function (result) {
    sendJson(res, result);
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
}
```

### 4. `cli/lib/web.js` HTML 模板

在 `diffDetailPage` section 内（约 line 3032-3049），在现有 diff-view-panel **上方**添加 conflict info 面板：

```html
<section id="conflictInfo" class="diff-view-panel" style="margin-bottom:14px;border-left:3px solid #b45309;background:#fffbeb;" hidden>
  <div class="diff-view-head" style="background:#fffbeb;">
    <div>
      <h2 class="diff-view-title" style="color:#92400e;">
        <span data-i18n="mergeConflict">🔀 Merge Conflict</span>
      </h2>
      <div id="conflictMergeInfo" class="meta"></div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button id="btnResolveConflict" class="commit-button" type="button" data-i18n="resolveConflict" style="background:#d97706;border-color:#d97706;">🤖 AI Resolve</button>
      <button id="btnManualEdit" class="copy-button" type="button" data-i18n="manualEdit">Manual Edit</button>
    </div>
  </div>
  <div id="conflictStatus" class="meta" style="padding:10px 16px;"></div>
</section>
```

### 5. `cli/lib/web.js` 客户端 JS

#### A. 新增 i18n 条目

在 `zh-CN` 和 `en` locale 对象中添加：

```javascript
// zh-CN:
mergeConflict: '🔀 合并冲突',
resolveConflict: '🤖 AI 解决',
manualEdit: '手动编辑',
resolvingConflict: '正在调用 AI 分析冲突...',
conflictResolveFailed: 'AI 合并失败：',
conflictResolved: 'AI 合并完成！文件已暂存。',
conflictAcceptFailed: '合并方案写入失败：',
conflictNoConflictInfo: '无法获取冲突信息',
editInEditor: '在编辑器中编辑',
editSaveAndAccept: '保存并接受',

// en:
mergeConflict: '🔀 Merge Conflict',
resolveConflict: '🤖 AI Resolve',
manualEdit: 'Manual Edit',
resolvingConflict: 'Resolving conflict with AI...',
conflictResolveFailed: 'AI resolution failed: ',
conflictResolved: 'AI resolved! File staged.',
conflictAcceptFailed: 'Failed to apply resolution: ',
conflictNoConflictInfo: 'Could not load conflict details',
editInEditor: 'Edit in Editor',
editSaveAndAccept: 'Save & Accept',
```

#### B. 修改 `renderDiffView` — 检测 UU 文件时显示冲突信息

将现有 `renderDiffView` 改为：

```javascript
function renderDiffView(data) {
  $('diffViewTitle').textContent = data.displayPath || data.path || state.diffViewPath;
  $('diffViewMeta').textContent = [data.code, data.truncated ? t('truncatedFile') : ''].filter(Boolean).join(' · ');
  renderBreadcrumb('diffBreadcrumb', data.path || state.diffViewPath);
  $('diffViewContent').innerHTML = diffCodeHtml(data.diff || '');

  // Show conflict info for UU files
  var conflictInfo = $('conflictInfo');
  if (data.mergeConflict && conflictInfo) {
    conflictInfo.hidden = false;
    var mergeInfo = $('conflictMergeInfo');
    if (mergeInfo) {
      mergeInfo.textContent = data.displayPath + ' · ' + (data.branch || '?') + ' ← ' + (data.mergeBranch || '?');
    }
  } else if (conflictInfo) {
    conflictInfo.hidden = true;
  }
}
```

#### C. 新增冲突解决交互逻辑

在客户端 JS 中（比如在 `closeDiffDetailPage` 附近）添加：

```javascript
function bindConflictControls() {
  var resolveBtn = $('btnResolveConflict');
  if (resolveBtn) {
    resolveBtn.addEventListener('click', function() {
      resolveConflictWithAI(state.diffViewPath);
    });
  }
  var editBtn = $('btnManualEdit');
  if (editBtn) {
    editBtn.addEventListener('click', function() {
      manualEditConflict(state.diffViewPath);
    });
  }
}

function resolveConflictWithAI(filePath) {
  if (!filePath || state.resolvingConflict) return;
  state.resolvingConflict = true;
  var btn = $('btnResolveConflict');
  var status = $('conflictStatus');
  if (btn) { btn.disabled = true; btn.textContent = t('resolvingConflict'); }
  if (status) { status.textContent = t('resolvingConflict'); status.className = 'meta'; }

  fetch('/api/merge/accept-file?repo=' + encodeURIComponent(targetRepo), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath })
  })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .then(function(data) {
      if (status) { status.textContent = t('conflictResolved'); status.className = 'meta'; }
      if (btn) { btn.textContent = t('resolveConflict'); btn.disabled = false; }
      setTimeout(function() { closeDiffDetailPage(); }, 800);
    })
    .catch(function(error) {
      if (status) { status.textContent = t('conflictResolveFailed') + error.message; status.className = 'meta error'; }
      if (btn) { btn.textContent = t('resolveConflict'); btn.disabled = false; }
    })
    .finally(function() {
      state.resolvingConflict = false;
    });
}

function manualEditConflict(filePath) {
  // Open the conflicted file in a textarea modal for manual editing
  fetch('/api/file-diff?repo=' + encodeURIComponent(targetRepo) + '&path=' + encodeURIComponent(filePath), { cache: 'no-store' })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (!data.mergeConflict) return;
      // Load the raw conflicted content via a new endpoint
      return fetch('/api/merge/conflict-detail?repo=' + encodeURIComponent(targetRepo) + '&path=' + encodeURIComponent(filePath), { cache: 'no-store' });
    })
    .then(function(res) { return res.json(); })
    .then(function(detail) {
      var content = detail.conflicted || '';
      // Show in a modal with a textarea
      showConflictEditor(filePath, content);
    })
    .catch(function(error) {
      var status = $('conflictStatus');
      if (status) { status.textContent = error.message; status.className = 'meta error'; }
    });
}

function showConflictEditor(filePath, content) {
  // Create an editor modal
  var modal = $('tokenConfirmModal');
  if (!modal) return;
  modal.innerHTML = [
    '<div class="modal" style="width:min(800px,96%);">',
    '  <h2>' + escapeHtml(t('mergeConflict')) + ': ' + escapeHtml(filePath) + '</h2>',
    '  <p style="margin-bottom:12px;color:var(--muted);">' + escapeHtml(t('manualEdit')) + '</p>',
    '  <textarea id="conflictEditor" style="width:100%;min-height:360px;border:1px solid var(--line);border-radius:7px;padding:10px;font-family:monospace;font-size:13px;line-height:1.5;resize:vertical;" spellcheck="false">' + escapeHtml(content) + '</textarea>',
    '  <div class="modal-actions">',
    '    <button id="cancelConflictEdit" class="copy-button" type="button">' + escapeHtml(t('cancel')) + '</button>',
    '    <button id="saveConflictEdit" class="commit-button" type="button">' + escapeHtml(t('editSaveAndAccept')) + '</button>',
    '  </div>',
    '</div>'
  ].join('');
  modal.classList.add('visible');

  $('cancelConflictEdit').addEventListener('click', function() {
    modal.classList.remove('visible');
  });
  $('saveConflictEdit').addEventListener('click', function() {
    var resolved = $('conflictEditor').value;
    // Save and git add
    fetch('/api/merge/accept-file?repo=' + encodeURIComponent(targetRepo), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content: resolved })
    })
      .then(function(res) { return res.json().then(function(d) { if (!res.ok) throw new Error(d.error); return d; }); })
      .then(function() {
        modal.classList.remove('visible');
        closeDiffDetailPage();
      })
      .catch(function(error) {
        alert(error.message);
      });
  });
}
```

#### D. 同时，服务器端 handleMergeAcceptFile 需要支持 body.content

修改为：如果 body.content 存在则用提供的内容，否则调 AI 生成：

```javascript
function handleMergeAcceptFile(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  readJsonBody(req).then(function (body) {
    var filePath = body.path;
    if (!filePath) return sendJsonError(res, 400, 'Missing file path');
    var mergeConflict = require('./merge-conflict');
    if (body.content) {
      fs.writeFileSync(path.resolve(git.repoRoot(targetRepo), filePath), body.content, 'utf8');
    } else {
      mergeConflict.resolveFile(targetRepo, filePath);
    }
    var valid = mergeConflict.validateResolution(path.join(git.repoRoot(targetRepo), filePath));
    if (!valid.valid) return sendJsonError(res, 400, valid.error);
    return { status: 'ok', path: filePath };
  }).then(function (result) {
    sendJson(res, result);
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
}
```

#### E. Additional endpoint for manual edit

```javascript
if (parsed.pathname === '/api/merge/conflict-detail') {
  handleMergeConflictDetail(req, res, parsed.query.repo);
  return;
}

function handleMergeConflictDetail(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  var urlParsed = url.parse(req.url, true);
  var filePath = urlParsed.query.path;
  if (!filePath) return sendJsonError(res, 400, 'Missing file path');
  try {
    var mergeConflict = require('./merge-conflict');
    var detail = mergeConflict.getConflictDetail(targetRepo, filePath);
    if (!detail) return sendJsonError(res, 400, 'Not a merge conflict');
    sendJson(res, detail);
  } catch (error) {
    sendJsonError(res, 500, error.message);
  }
}
```
