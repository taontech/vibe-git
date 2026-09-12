#!/usr/bin/env node

'use strict';

var env = require('../lib/env');
var childProcess = require('child_process');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var git = require('../lib/git');
var github = require('../lib/github');
var config = require('../lib/config');
var commitMessage = require('../lib/commit-message');
var prompts = require('../lib/prompts');
var agent = require('../lib/agent');
var autogmc = require('../lib/autogmc');
var taskStatus = require('../lib/task-status');
var web = require('../lib/web');
var agentMonitor = require('../lib/agent-monitor');
var mergeConflict = require('../lib/merge-conflict');
var packageInfo = require('../package.json');

var COMMANDS = ['agent', 'bind', 'status', 'message', 'commit', 'retry', 'install', 'install-hooks', 'web', 'hook', 'hook-worker', 'resolve-merge', 'help'];
var DIFF_LIMIT = 120000;

main().catch(function(error) {
  console.error('gmc: ' + error.message);
  process.exit(1);
});

async function main() {
  var parsed = parseArgs(process.argv.slice(2));
  var command = parsed.command;

  if (parsed.flags.version) {
    console.log(packageInfo.version);
    return;
  }

  if (!command || command === 'help' || parsed.flags.help) {
    var helpTarget = command === 'help' ? parsed.args[0] : (parsed.flags.help ? command : null);
    printHelp(helpTarget);
    return;
  }

  if (command === 'status') {
    showStatus();
    return;
  }

  if (command === 'agent') {
    agentCommand(parsed.args[0]);
    return;
  }

  if (command === 'bind') {
    await bindCommand(parsed.args[0], parsed.flags);
    return;
  }

  if (command === 'message') {
    generateMessageCommand(parsed.flags);
    return;
  }

  if (command === 'commit') {
    commitCommand(parsed.flags);
    return;
  }

  if (command === 'retry') {
    retryCommand(parsed.args[0]);
    return;
  }

  if (command === 'install-hooks') {
    installHooksCommand();
    return;
  }

  if (command === 'install') {
    await installCommand(parsed.flags);
    return;
  }

  if (command === 'web') {
    await gitWebCommand(parsed.flags);
    return;
  }

  if (command === 'hook') {
    hookCommand(parsed.args);
    return;
  }

  if (command === 'hook-worker') {
    autogmc.worker(parsed.args[0]);
    return;
  }

  if (command === 'resolve-merge') {
    resolveMergeCommand(parsed.args[0], parsed.flags);
    return;
  }

  await startIssueCommand(command, parsed.flags);
}

function parseArgs(argv) {
  var flags = {
    agent: null,
    execMode: false,
    dryRun: false,
    noBranch: false,
    noEdit: false,
    noOpen: false,
    all: false,
    help: false,
    printPrompt: false,
    port: null,
    start: false,
    tmp: false,
    restart: false,
    quit: false,
    watch: false,
    version: false,
    list: false
  };
  var positional = [];

  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === '--agent') {
      flags.agent = argv[++i];
    } else if (arg.indexOf('--agent=') === 0) {
      flags.agent = arg.slice('--agent='.length);
    } else if (arg === '--exec') {
      flags.execMode = true;
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--no-branch') {
      flags.noBranch = true;
    } else if (arg === '--no-edit') {
      flags.noEdit = true;
    } else if (arg === '--no-open') {
      flags.noOpen = true;
    } else if (arg === '--all') {
      flags.all = true;
    } else if (arg === '--port') {
      flags.port = argv[++i];
    } else if (arg.indexOf('--port=') === 0) {
      flags.port = arg.slice('--port='.length);
    } else if (arg === '--print-prompt') {
      flags.printPrompt = true;
    } else if (arg === '--start') {
      flags.start = true;
    } else if (arg === '--tmp') {
      flags.tmp = true;
    } else if (arg === '--restart') {
      flags.restart = true;
    } else if (arg === '--quit') {
      flags.quit = true;
    } else if (arg === '--watch' || arg === '--dev') {
      flags.watch = true;
    } else if (arg === '--version' || arg === '-v') {
      flags.version = true;
    } else if (arg === '-h' || arg === '--help') {
      flags.help = true;
    } else if (arg === '--list') {
      flags.list = true;
    } else {
      positional.push(arg);
    }
  }

  var first = positional.shift();
  if (COMMANDS.indexOf(first) >= 0) {
    return {
      command: first,
      args: positional,
      flags: flags
    };
  }

  return {
    command: first,
    args: positional,
    flags: flags
  };
}

async function startIssueCommand(issueRef, flags) {
  if (!issueRef) {
    printHelp();
    return;
  }

  var root = git.repoRoot(process.cwd());
  var issue = await loadIssue(issueRef, root);
  var selectedAgent = flags.agent ? config.normalizeAgent(flags.agent) : config.currentAgent();
  var prompt = prompts.issuePrompt(issue);

  if (flags.printPrompt || flags.dryRun) {
    console.log(prompt);
    return;
  }

  if (!flags.noBranch) {
    var branch = git.branchName(issue.ref, issue.title);
    git.ensureBranch(branch, root);
  }

  var binding = config.bindIssue(root, issue, selectedAgent);
  console.log('Bound ' + binding.issue + ' to branch ' + binding.branch + '.');

  agent.launchAgent({
    agent: selectedAgent,
    cwd: root,
    prompt: prompt,
    execMode: flags.execMode,
    dryRun: flags.dryRun
  });
}

async function bindCommand(issueRef, flags) {
  if (!issueRef) {
    throw new Error('bind requires an issue reference, for example: gmc bind GH-234');
  }
  var root = git.repoRoot(process.cwd());
  var issue = await loadIssue(issueRef, root);
  var selectedAgent = flags.agent ? config.normalizeAgent(flags.agent) : config.currentAgent();
  var binding = config.bindIssue(root, issue, selectedAgent);
  console.log('Bound ' + binding.issue + ' to branch ' + binding.branch + '.');
}

function agentCommand(agentName) {
  if (!agentName) {
    console.log('Agent: ' + config.currentAgent());
    return;
  }

  var selectedAgent = config.setAgent(agentName);
  console.log('Agent set to ' + selectedAgent + '.');
  console.log('Config: ' + config.configPath());
}

function showStatus() {
  var root = git.repoRoot(process.cwd());
  var binding = config.readBinding(root);
  var branch = git.currentBranch(root);

  console.log('Repository: ' + root);
  console.log('Branch:     ' + branch);
  if (!binding) {
    console.log('Issue:      (none)');
    console.log('Agent:      ' + config.currentAgent());
    printBackgroundTasks(root);
    return;
  }
  console.log('Issue:      ' + binding.issue);
  console.log('Title:      ' + (binding.title || '(none)'));
  console.log('URL:        ' + (binding.url || '(none)'));
  console.log('Agent:      ' + (binding.agent || 'codex'));
  printBackgroundTasks(root);
}

function generateMessageCommand(flags) {
  var root = git.repoRoot(process.cwd());
  var generated = generateCommitMessage(root, flags);
  var message = generated.message;
  process.stdout.write(message);
}

function commitCommand(flags) {
  var root = git.repoRoot(process.cwd());
  var generated = generateCommitMessage(root, flags, { taskStatus: true });
  var message = generated.message;
  var binding = generated.binding;
  var messageFile = git.writeGitFile(root, 'GMC_COMMIT_EDITMSG', message);

  if (!flags.noEdit) {
    editFile(messageFile, root);
    message = fs.readFileSync(messageFile, 'utf8');
    commitMessage.validate(message, binding);
  }

  git.runGit(['commit', '-F', messageFile], { cwd: root });
  console.log('Committed with message from ' + messageFile + '.');
  applyTaskUpdates(root, generated.taskUpdates);
}

function retryCommand(ref) {
  var root = git.repoRoot(process.cwd());
  var target = ref || 'HEAD';
  var targetOid = git.runGit(['rev-parse', target + '^{commit}'], { cwd: root });
  autogmc.startTask(root, __filename, targetOid, new Date().toISOString());
  console.log('Queued background message retry for ' + targetOid.slice(0, 12) + '.');
}

function hookCommand(args) {
  var hookName = args[0];
  if (hookName === 'commit-msg') {
    autogmc.commitMsgHook(args[1]);
    return;
  }
  if (hookName === 'post-commit') {
    autogmc.postCommitHook(__filename);
    return;
  }
  throw new Error('Unknown hook: ' + (hookName || '(none)'));
}

function installHooksCommand() {
  var root = git.repoRoot(process.cwd());
  installHooks(root);
  console.log('Installed gmc hooks in ' + git.gitDir(root) + '/hooks.');
}

async function installCommand(flags) {
  if (!flags.all) {
    throw new Error('install requires --all. Use: gmc install --all');
  }
  var root = git.repoRoot(process.cwd());
  installHooks(root);
  console.log('Installed gmc hooks in ' + git.gitDir(root) + '/hooks.');
}

function installHooks(root) {
  ['commit-msg', 'post-commit'].forEach(function(fileName) {
    installHook(root, fileName);
  });
}

async function gitWebCommand(flags) {
  var port = flags.port || process.env.GMC_GITWEB_PORT || web.DEFAULT_PORT;
  var isRunning = await web.checkRunning(port);
  var root = tryGetRepoRoot();

  if (flags.watch) {
    await runWatchedGitWeb(root || process.cwd(), flags, port, isRunning);
    return;
  }

  if (flags.quit) {
    if (isRunning) {
      await web.quit(port);
      console.log('GMC Web server stopped.');
    } else {
      console.log('GMC Web is not running on port ' + port + '.');
    }
    return;
  }

  if (flags.restart) {
    if (isRunning) {
      await web.quit(port);
      console.log('GMC Web server stopped.');
      await new Promise(function(resolve) { setTimeout(resolve, 500); });
      isRunning = false;
    }
  }

  if (isRunning) {
    var address = web.authenticatedUrl(null, {
      port: port
    });
    console.log('GMC Web is already running on port ' + port + '.');
    if (!flags.noOpen) {
      console.log('Opening ' + address);
      web.openBrowser(address);
    } else {
      console.log('Address: ' + address);
    }
    return;
  }

  if (!flags.tmp) {
    var childArgs = ['web', '--tmp', '--port', String(port), '--no-open'];
    var child = childProcess.spawn(process.execPath, [__filename].concat(childArgs), {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    var started = await waitForServer(port, 5000);
    if (!started) {
      console.error('Failed to start GMC Web server on port ' + port + '.');
      process.exitCode = 1;
      return;
    }
    var address = web.authenticatedUrl(root, {
      port: port
    });
    console.log('GMC Web server started in background on port ' + port + '.');
    if (!flags.noOpen) {
      console.log('Opening ' + address);
      web.openBrowser(address);
    } else {
      console.log('Address: ' + address);
    }
    return;
  }

  var monitorManager = agentMonitor.createManager();
  var monitorState = await monitorManager.start();
  if (monitorState.healthy) {
    console.log(
      'Agent Monitor: ' + monitorState.url +
      (monitorState.owned ? ' (started by GMC)' : ' (reused)')
    );
  } else if (monitorState.status !== 'disabled') {
    console.error('Agent Monitor unavailable: ' + agentMonitor.describe(monitorState));
  }

  var started;
  try {
    started = await web.start(root || process.cwd(), {
      port: flags.port,
      noOpen: flags.noOpen,
      agentMonitor: monitorState,
      onQuit: function () {
        return monitorManager.stop();
      }
    });
  } catch (error) {
    await monitorManager.stop();
    throw error;
  }
  var stoppingWeb = false;
  function stopWebForSignal() {
    if (stoppingWeb) return;
    stoppingWeb = true;
    monitorManager.stop().then(function () {
      process.exit(0);
    }, function (error) {
      console.error('Agent Monitor cleanup failed: ' + error.message);
      process.exit(1);
    });
  }
  process.once('SIGINT', stopWebForSignal);
  process.once('SIGTERM', stopWebForSignal);
  console.log('GMC Web: ' + started.url);
  if (root) {
    console.log('Repository: ' + root);
  } else {
    console.log('Started in global mode (no repository found).');
  }
  console.log('Press Ctrl-C to stop.');
}

async function runWatchedGitWeb(root, flags, port, isRunning) {
  if (isRunning) {
    await web.quit(port);
    await delay(500);
  }

  var child = null;
  var quietChildren = [];
  var restarting = false;
  var stopping = false;
  var address = web.authenticatedUrl(root, {
    port: port
  });
  var watchFiles = [
    path.resolve(__dirname, '../lib/web.js'),
    path.resolve(__dirname, '../lib/agent-monitor.js')
  ];
  var fileHashes = {};
  watchFiles.forEach(function(filePath) {
    fileHashes[filePath] = fileHash(filePath);
  });

  function startChild() {
    var env = Object.assign({}, process.env, {
      GMC_GITWEB_LIVE_RELOAD: '1',
      GMC_GITWEB_RELOAD_TOKEN: String(Date.now())
    });
    var spawned = childProcess.spawn(process.execPath, [__filename, 'web', '--tmp', '--port', String(port), '--no-open'], {
      env: env,
      stdio: 'inherit'
    });
    child = spawned;
    spawned.on('exit', function(code, signal) {
      var quietIndex = quietChildren.indexOf(spawned);
      if (quietIndex >= 0) {
        quietChildren.splice(quietIndex, 1);
        return;
      }
      if (!stopping && !restarting) {
        console.error('GMC Web child exited' + (signal ? ' by ' + signal : ' with code ' + code) + '.');
      }
    });
  }

  async function restartChild(filePath) {
    if (restarting || stopping) return;
    restarting = true;
    console.log('Reloading GitWeb after ' + path.basename(filePath) + ' changed...');
    if (child && child.exitCode == null) {
      quietChildren.push(child);
      await web.quit(port);
      await delay(300);
      if (child.exitCode == null) child.kill();
    }
    startChild();
    restarting = false;
  }

  startChild();
  var watchStarted = await waitForServer(port, 5000);
  if (!watchStarted) {
    console.error('Failed to start GMC Web server on port ' + port + '.');
  } else if (!flags.noOpen) {
    web.openBrowser(address);
  }
  console.log('GMC Web watch: ' + address);
  console.log('Watching: ' + watchFiles.map(function(filePath) { return path.relative(process.cwd(), filePath); }).join(', '));
  console.log('Press Ctrl-C to stop.');

  var debounceTimer = null;
  watchFiles.forEach(function(filePath) {
    fs.watch(filePath, { persistent: true }, function() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function() {
        var nextHash = fileHash(filePath);
        if (!nextHash || nextHash === fileHashes[filePath]) return;
        fileHashes[filePath] = nextHash;
        restartChild(filePath);
      }, 500);
    });
  });

  await new Promise(function(resolve) {
    function stop() {
      if (stopping) return;
      stopping = true;
      if (child && child.exitCode == null) child.kill();
      resolve();
    }
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

async function waitForServer(port, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 5000);
  while (Date.now() < deadline) {
    var running = await web.checkRunning(port);
    if (running) {
      return true;
    }
    await delay(100);
  }
  return false;
}

function delay(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

function fileHash(filePath) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
  } catch (error) {
    return null;
  }
}

function installHook(root, fileName) {
  var target = path.join(git.gitDir(root), 'hooks', fileName);
  var existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (existing && existing.indexOf('# GMHOOK') < 0) {
    throw new Error(target + ' already exists and is not managed by gmc.');
  }
  fs.writeFileSync(target, hookScript(fileName));
  fs.chmodSync(target, 0o755);
}

function printBackgroundTasks(root) {
  var tasks = autogmc.taskSummaries(root, 5);
  if (!tasks.length) {
    console.log('Background: (none)');
    return;
  }

  console.log('Background:');
  tasks.forEach(function(task) {
    var label = task.shortOid + ' ' + task.status;
    if ((task.status === 'running' || task.status === 'waiting') && task.age) {
      label += ' for ' + task.age;
    }
    if (task.status === 'stale') {
      label += ' (no update after ' + task.timeoutSeconds + 's timeout)';
    }
    console.log('  - ' + label);
    if (task.status === 'done' && task.message) {
      console.log('    message: ' + firstLine(task.message));
    }
    if (task.error) {
      console.log('    error:   ' + firstLine(task.error));
    }
    if (task.reason) {
      console.log('    reason:  ' + task.reason);
    }
    console.log('    log:     ' + task.logPath);
  });
}

function firstLine(value) {
  return String(value || '').trim().split(/\r?\n/)[0] || '(empty)';
}

function hookScript(fileName) {
  var base = [
    '#!/bin/sh',
    '# GMHOOK',
    ''
  ];
  if (fileName === 'commit-msg') {
    base.push('exec ' + shellQuote(process.execPath) + ' ' + shellQuote(__filename) + ' hook commit-msg "$1"');
  } else if (fileName === 'post-commit') {
    base.push('exec ' + shellQuote(process.execPath) + ' ' + shellQuote(__filename) + ' hook post-commit');
  } else {
    throw new Error('Unknown hook file: ' + fileName);
  }
  return base.join('\n') + '\n';
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function generateCommitMessage(root, flags, options) {
  options = options || {};
  var binding = config.readBinding(root);
  if (!git.hasStagedDiff(root)) {
    throw new Error('No staged changes. Run git add before gmc message or gmc commit.');
  }

  var diff = git.stagedDiff(root);
  if (diff.length > DIFF_LIMIT) {
    diff = diff.slice(0, DIFF_LIMIT) + '\n\n[Diff truncated by gmc]\n';
  }

  var tasks = options.taskStatus ? taskStatus.readUnfinishedTasksForPrompt(root) : [];
  var prompt = tasks.length ? prompts.commitMessagePlanPrompt(
    binding,
    diff,
    git.statusShort(root),
    tasks
  ) : prompts.commitMessagePrompt(
    binding,
    diff,
    git.statusShort(root)
  );

  if (flags.printPrompt) {
    return {
      binding: binding,
      message: prompt + '\n',
      taskUpdates: []
    };
  }

  var selectedAgent = config.currentCommitAgent();
  var raw = agent.generateText(prompt, root, selectedAgent, {
    outputPrefix: tasks.length ? 'gmc-commit-plan' : 'gmc-commit-message',
    description: tasks.length ? 'commit plan generation' : 'commit message generation'
  });
  var taskUpdates = [];
  if (tasks.length) {
    var plan = taskStatus.parseCommitPlan(raw);
    raw = plan.message;
    taskUpdates = plan.taskUpdates;
  }
  var message = prompts.appendCreatedBy(
    raw,
    selectedAgent
  );
  message = commitMessage.prepare(message, binding);
  return {
    binding: binding,
    message: message,
    taskUpdates: taskUpdates
  };
}

function applyTaskUpdates(root, updates) {
  if (!updates || !updates.length) {
    return;
  }
  try {
    var applied = taskStatus.applyUpdates(root, updates);
    if (applied.updates.length) {
      console.log('Updated task statuses in working tree: ' + applied.updates.map(function (item) {
        return item.id + ' -> ' + item.status;
      }).join(', ') + '.');
    }
  } catch (error) {
    console.error('gmc: task status update skipped after commit: ' + error.message);
  }
}

async function loadIssue(issueRef, root) {
  var parsed = github.parseIssueRef(issueRef);
  var remoteRepo = git.parseGitHubRemote(git.originUrl(root));
  var repo = {
    owner: parsed.owner || (remoteRepo && remoteRepo.owner),
    repo: parsed.repo || (remoteRepo && remoteRepo.repo)
  };

  if (!repo.owner || !repo.repo) {
    throw new Error('Could not infer GitHub repo from origin remote. Use a full GitHub issue URL.');
  }

  var token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  return github.fetchIssue(repo, parsed.number, token);
}

function tryGetRepoRoot() {
  try {
    return git.repoRoot(process.cwd());
  } catch (error) {
    return null;
  }
}

function editFile(filePath, cwd) {
  var editor = process.env.GIT_EDITOR || process.env.EDITOR || 'vi';
  var parts = editor.split(/\s+/).filter(Boolean);
  var command = parts.shift();
  var result = childProcess.spawnSync(command, parts.concat([filePath]), {
    cwd: cwd,
    stdio: 'inherit'
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(editor + ' exited with status ' + result.status);
  }
}

function resolveMergeCommand(fileArg, flags) {
  var root = git.repoRoot(process.cwd());
  if (flags.list || (fileArg === '--list')) {
    var files = mergeConflict.listConflictedFiles(root);
    if (!files.length) {
      console.log('No merge conflicts.');
      return;
    }
    var info = mergeConflict.getMergeBranches(root);
    if (info) {
      console.log('Merge: ' + info.branch + ' <- ' + info.mergeBranch);
    }
    console.log('Conflicted files:');
    files.forEach(function(f) { console.log('  ' + f); });
    return;
  }

  if (fileArg) {
    console.log('Resolving conflict in: ' + fileArg);
    mergeConflict.resolveFile(root, fileArg);
    console.log('Resolved and staged: ' + fileArg);
  } else {
    var allFiles = mergeConflict.listConflictedFiles(root);
    if (!allFiles.length) {
      console.log('No merge conflicts to resolve.');
      return;
    }
    allFiles.forEach(function(f) {
      console.log('Resolving conflict in: ' + f);
      mergeConflict.resolveFile(root, f);
      console.log('Resolved and staged: ' + f);
    });
    console.log('All conflicts resolved.');
  }
}

function isIssueRef(value) {
  if (!value) return false;
  try {
    github.parseIssueRef(value);
    return true;
  } catch (error) {
    return false;
  }
}

function getCommandHelp(command) {
  var helps = {
    web: [
      'Usage:',
      '  gmc web [options]',
      '',
      'Description:',
      '  Start the local GitWeb browser dashboard and Agent Monitor.',
      '  By default, runs as a background daemon and opens the dashboard in your default browser.',
      '  If already running, opens the browser to the existing server.',
      '',
      'Options:',
      '  --port <port>        Port to listen on (default: 4277, or GMC_GITWEB_PORT)',
      '  --no-open            Do not open browser automatically',
      '  --tmp                Run in foreground (blocking process) instead of background daemon',
      '  --restart            Restart running background GitWeb server daemon',
      '  --quit               Stop running background GitWeb server daemon',
      '  --watch, --dev       Run in foreground with live reload when web files change',
      '  -h, --help           Show help for web command',
      '',
      'Examples:',
      '  $ gmc web',
      '  $ gmc web --port 5000',
      '  $ gmc web --no-open',
      '  $ gmc web --tmp',
      '  $ gmc web --restart',
      '  $ gmc web --quit',
      '  $ gmc web --watch'
    ],
    status: [
      'Usage:',
      '  gmc status',
      '',
      'Description:',
      '  Display repository binding, active git branch, bound GitHub issue,',
      '  active AI agent, and recent background commit message generation tasks.',
      '',
      'Options:',
      '  -h, --help           Show help for status command',
      '',
      'Examples:',
      '  $ gmc status'
    ],
    commit: [
      'Usage:',
      '  gmc commit [options]',
      '',
      'Description:',
      '  Generate an AI commit message based on staged changes and commit them.',
      '  Opens your editor ($GIT_EDITOR, $EDITOR, or vi) to review and edit the',
      '  generated message before committing. Also advances related Markdown',
      '  task statuses in .gmc/tasks/ when applicable.',
      '',
      'Options:',
      '  --no-edit            Commit immediately without opening editor',
      '  --print-prompt       Print generated prompt to stdout instead of committing',
      '  -h, --help           Show help for commit command',
      '',
      'Examples:',
      '  $ git add . && gmc commit',
      '  $ git add . && gmc commit --no-edit',
      '  $ gmc commit --print-prompt'
    ],
    message: [
      'Usage:',
      '  gmc message [options]',
      '',
      'Description:',
      '  Generate an AI commit message based on staged changes and print it',
      '  to stdout without committing.',
      '',
      'Options:',
      '  --print-prompt       Print generated prompt to stdout instead of calling AI',
      '  -h, --help           Show help for message command',
      '',
      'Examples:',
      '  $ git add . && gmc message',
      '  $ gmc message --print-prompt'
    ],
    retry: [
      'Usage:',
      '  gmc retry [commit]',
      '',
      'Description:',
      '  Re-queue background commit message generation for a commit that failed',
      '  or needs regeneration. Background worker generates the message and',
      '  rewrites the commit (only if it is still HEAD).',
      '',
      'Arguments:',
      '  [commit]             Commit reference to retry (default: HEAD)',
      '',
      'Options:',
      '  -h, --help           Show help for retry command',
      '',
      'Examples:',
      '  $ gmc retry',
      '  $ gmc retry HEAD',
      '  $ gmc retry a1b2c3d'
    ],
    'resolve-merge': [
      'Usage:',
      '  gmc resolve-merge [file] [options]',
      '',
      'Description:',
      '  Resolve Git merge conflicts using AI. If a file is specified, resolves',
      '  conflicts in that file and stages it. If no file is specified, resolves',
      '  all conflicted files in the repository and stages them.',
      '',
      'Arguments:',
      '  [file]               Specific conflicted file to resolve',
      '',
      'Options:',
      '  --list               List conflicted files and merge branches without resolving',
      '  -h, --help           Show help for resolve-merge command',
      '',
      'Examples:',
      '  $ gmc resolve-merge --list',
      '  $ gmc resolve-merge',
      '  $ gmc resolve-merge path/to/conflicted-file.js'
    ],
    agent: [
      'Usage:',
      '  gmc agent [name]',
      '',
      'Description:',
      '  Display or configure the default AI coding agent. Configuration is',
      '  saved globally in ~/.config/gmc/config.json.',
      '',
      'Arguments:',
      '  [name]               Agent name to set: codex | claude | antigravity',
      '                       If omitted, displays the currently active agent.',
      '',
      'Options:',
      '  -h, --help           Show help for agent command',
      '',
      'Examples:',
      '  $ gmc agent',
      '  $ gmc agent codex',
      '  $ gmc agent claude',
      '  $ gmc agent antigravity'
    ],
    bind: [
      'Usage:',
      '  gmc bind <issue> [options]',
      '',
      'Description:',
      '  Bind current repository and branch to a GitHub issue without',
      '  launching an AI agent session.',
      '',
      'Arguments:',
      '  <issue>              GitHub issue reference (e.g. 42, #42, GH-42, full URL)',
      '',
      'Options:',
      '  --agent <name>       AI agent to associate with binding (codex, claude, antigravity)',
      '  -h, --help           Show help for bind command',
      '',
      'Examples:',
      '  $ gmc bind GH-234',
      '  $ gmc bind 42 --agent claude',
      '  $ gmc bind https://github.com/owner/repo/issues/42'
    ],
    install: [
      'Usage:',
      '  gmc install --all',
      '  gmc install-hooks',
      '',
      'Description:',
      '  Install gmc Git hooks (commit-msg and post-commit) into .git/hooks.',
      '  Enables the background AI commit workflow: `git commit -m gmc`.',
      '',
      'Options:',
      '  --all                Confirm installation of all hooks (required for gmc install)',
      '  -h, --help           Show help for install command',
      '',
      'Examples:',
      '  $ gmc install --all',
      '  $ gmc install-hooks'
    ],
    issue: [
      'Usage:',
      '  gmc <issue> [options]',
      '',
      'Description:',
      '  Fetch a GitHub issue, create a dedicated branch, bind the issue to',
      '  the repository, and launch an AI coding session.',
      '',
      'Arguments:',
      '  <issue>              GitHub issue reference (e.g. 42, #42, GH-42, full URL)',
      '',
      'Options:',
      '  --agent <name>       AI agent to launch: codex | claude | antigravity',
      '  --exec               Run agent in interactive execution mode',
      '  --no-branch          Stay on current branch instead of creating an issue branch',
      '  --dry-run            Print issue prompt without launching the agent',
      '  --print-prompt       Same as --dry-run; print prompt to stdout',
      '  -h, --help           Show help',
      '',
      'Examples:',
      '  $ gmc 42',
      '  $ gmc GH-234 --agent codex',
      '  $ gmc https://github.com/owner/repo/issues/101 --exec',
      '  $ gmc GH-234 --dry-run'
    ],
    hook: [
      'Usage:',
      '  gmc hook <commit-msg|post-commit> [args]',
      '  gmc hook-worker <task-oid>',
      '',
      'Description:',
      '  Internal plumbing commands invoked by Git hooks and background workers.',
      '  Not intended for direct manual invocation.',
      '',
      'Options:',
      '  -h, --help           Show help for hook command'
    ]
  };

  helps['install-hooks'] = helps.install;
  helps['hook-worker'] = helps.hook;

  return helps[command] || null;
}

function getMainHelp() {
  return [
    'gmc - Local GitWeb dashboard and AI-assisted commit messages for Git repositories',
    '',
    'Usage:',
    '  gmc <command> [options] [arguments]',
    '  gmc <issue> [options]',
    '  git commit -m gmc',
    '',
    'Commands:',
    '  web              Start local GitWeb browser dashboard and Agent Monitor',
    '  status           Show repository status, issue binding, and background tasks',
    '  commit           Generate AI commit message for staged changes and commit',
    '  message          Generate AI commit message for staged changes to stdout',
    '  retry            Re-queue background commit message generation for a commit',
    '  resolve-merge    Resolve Git merge conflicts using AI',
    '  agent            View or configure default AI coding agent',
    '  bind             Bind current branch to a GitHub issue without launching agent',
    '  install          Install git hooks into repository (--all required)',
    '  install-hooks    Install gmc Git hooks (commit-msg, post-commit) directly',
    '  help             Display help for a specific command (e.g., gmc help web)',
    '',
    'Issue Workflow:',
    '  gmc <issue>      Fetch GitHub issue, create branch, bind repo, and launch AI agent',
    '                   Supported formats: 42, #42, GH-42, or full GitHub issue URL',
    '',
    'Options:',
    '  -h, --help           Show help information (use "gmc <command> -h" for command details)',
    '  -v, --version        Show version number',
    '  --agent <name>       Specify AI agent: codex | claude | antigravity',
    '  --exec               Run agent in interactive execution mode (issue workflow)',
    '  --no-branch          Do not create a new branch for the issue',
    '  --no-edit            Commit directly without opening editor for confirmation',
    '  --no-open            Do not open browser automatically (web command)',
    '  --port <port>        Set GitWeb server port (default: 4277 or GMC_GITWEB_PORT)',
    '  --tmp                Run GitWeb server in foreground (blocking process)',
    '  --restart            Restart running background GitWeb server daemon',
    '  --quit               Stop running background GitWeb server daemon',
    '  --watch, --dev       Watch web files and auto-reload GitWeb on change',
    '  --list               List conflicted files without resolving (resolve-merge)',
    '  --all                Confirm installation of all hooks (required for gmc install)',
    '  --dry-run            Print issue prompt without executing the agent',
    '  --print-prompt       Print generated prompt to stdout without calling AI',
    '',
    'AI Commit Workflow (Background Generation):',
    '  1. Install hooks:    gmc install --all',
    '  2. Stage changes:    git add .',
    '  3. Commit with gmc:  git commit -m gmc',
    '     (Returns immediately; AI generates commit message in background and rewrites HEAD)',
    '  4. Check progress:   gmc status',
    '  5. Retry if needed:  gmc retry HEAD',
    '',
    'Environment Variables:',
    '  GITHUB_TOKEN, GH_TOKEN     GitHub API token for issue authentication',
    '  GMC_CODEX_MODEL            Override AI model used for commit message generation',
    '  GMC_CODEX_TIMEOUT_MS       Timeout for AI generation in milliseconds (default: 600000)',
    '  GMC_GITWEB_PORT            Default port for local GitWeb dashboard (default: 4277)',
    '  GIT_EDITOR, EDITOR         Editor for reviewing commit messages (default: vi)',
    '',
    'Examples:',
    '  $ gmc web                          # Start GitWeb dashboard in background',
    '  $ gmc web --port 5000              # Start GitWeb on custom port',
    '  $ gmc web --watch                  # Run GitWeb in dev mode with live reload',
    '  $ git commit -m gmc                # Commit immediately; AI rewrites in background',
    '  $ gmc status                       # Check background commit message status',
    '  $ gmc retry HEAD                   # Retry failed message generation for HEAD',
    '  $ git add . && gmc commit          # Generate AI message and review in editor',
    '  $ git add . && gmc commit --no-edit # Commit directly with AI message (no editor)',
    '  $ git add . && gmc message         # Preview AI commit message in terminal',
    '  $ gmc resolve-merge                # Resolve all merge conflicts using AI',
    '  $ gmc resolve-merge --list         # List conflicted files without resolving',
    '  $ gmc resolve-merge src/app.js     # Resolve conflicts in a specific file',
    '  $ gmc agent antigravity            # Set default AI coding agent',
    '  $ gmc GH-234 --agent codex         # Start issue GH-234 with Codex agent',
    '  $ gmc install --all                # Install commit hooks in current repo',
    '',
    'Learn more:',
    '  Use "gmc <command> --help" for more information about a specific command.'
  ];
}

function printHelp(target) {
  if (target) {
    var cmdHelp = getCommandHelp(target);
    if (cmdHelp) {
      console.log(cmdHelp.join('\n'));
      return;
    }
    if (target === 'issue' || target === '<issue>' || isIssueRef(target)) {
      var issueHelp = getCommandHelp('issue');
      if (issueHelp) {
        console.log(issueHelp.join('\n'));
        return;
      }
    }
  }
  console.log(getMainHelp().join('\n'));
}
