#!/usr/bin/env node

'use strict';

var childProcess = require('child_process');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var git = require('../lib/git');
var github = require('../lib/github');
var config = require('../lib/config');
var prompts = require('../lib/prompts');
var agent = require('../lib/agent');
var autogmc = require('../lib/autogmc');
var taskStatus = require('../lib/task-status');
var web = require('../lib/web');
var packageInfo = require('../package.json');

var COMMANDS = ['agent', 'bind', 'status', 'message', 'commit', 'retry', 'install', 'install-hooks', 'web', 'hook', 'hook-worker', 'help'];
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
    printHelp();
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
    restart: false,
    quit: false,
    watch: false,
    version: false
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
  var taskUpdates = taskStatus.updateForStagedCommit(root);
  var generated = generateCommitMessage(root, flags);
  var message = generated.message;
  var binding = generated.binding;
  var messageFile = git.writeGitFile(root, 'GMC_COMMIT_EDITMSG', message);

  if (!flags.noEdit) {
    editFile(messageFile, root);
    message = fs.readFileSync(messageFile, 'utf8');
    validateCommitMessage(message, binding);
  }

  git.runGit(['commit', '-F', messageFile], { cwd: root });
  console.log('Committed with message from ' + messageFile + '.');
  if (taskUpdates.updates.length) {
    console.log('Updated task statuses: ' + taskUpdates.updates.map(function (item) {
      return item.id + ' -> ' + item.status;
    }).join(', ') + '.');
  }
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
  var port = await web.resolveWeblocPort(flags.port || process.env.GMC_GITWEB_PORT || web.DEFAULT_PORT);
  var linkPath = web.createWebloc(root, {
    port: port
  });
  console.log('Installed gmc hooks in ' + git.gitDir(root) + '/hooks.');
  console.log('Created GitWeb link: ' + linkPath);
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
    flags.start = true;
  }

  if (flags.start) {
    if (isRunning) {
      console.log('GMC Web is already running on port ' + port + '.');
      return;
    }
    var childArgs = ['web', '--port', port, '--no-open'];
    var child = childProcess.spawn(process.execPath, [__filename].concat(childArgs), {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    console.log('GMC Web server started in background on port ' + port + '.');
    return;
  }

  if (isRunning) {
    if (root) {
      var address = web.authenticatedUrl(root, {
        port: port
      });
      var linkPath = web.createWebloc(root, {
        port: port
      });
      console.log('GMC Web is already running on port ' + port + '.');
      console.log('Opening ' + address);
      console.log('GitWeb link: ' + linkPath);
      if (!flags.noOpen) {
        web.openBrowser(address);
      }
    } else {
      console.log('GMC Web is already running on port ' + port + '.');
      console.log('Address: http://127.0.0.1:' + port + '/');
    }
    return;
  }

  var started = await web.start(root || process.cwd(), {
    port: flags.port,
    noOpen: flags.noOpen
  });
  console.log('GMC Web: ' + started.url);
  if (root) {
    var createdLinkPath = web.createWebloc(root, {
      port: started.port
    });
    console.log('Repository: ' + root);
    console.log('GitWeb link: ' + createdLinkPath);
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
    path.resolve(__dirname, '../lib/web.js')
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
    var spawned = childProcess.spawn(process.execPath, [__filename, 'web', '--port', String(port), '--no-open'], {
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
  if (!flags.noOpen) {
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

function generateCommitMessage(root, flags) {
  var binding = config.readBinding(root);
  if (!git.hasStagedDiff(root)) {
    throw new Error('No staged changes. Run git add before gmc message or gmc commit.');
  }

  var diff = git.stagedDiff(root);
  if (diff.length > DIFF_LIMIT) {
    diff = diff.slice(0, DIFF_LIMIT) + '\n\n[Diff truncated by gmc]\n';
  }

  var prompt = prompts.commitMessagePrompt(
    binding,
    diff,
    git.statusShort(root),
    git.recentCommitSubjects(root, 20)
  );

  if (flags.printPrompt) {
    return {
      binding: binding,
      message: prompt + '\n'
    };
  }

  var message = prompts.appendCreatedBy(
    agent.generateCommitMessage(prompt, root),
    binding ? binding.agent : config.currentAgent()
  );
  validateCommitMessage(message, binding);
  return {
    binding: binding,
    message: message
  };
}

function validateCommitMessage(message, binding) {
  var text = String(message || '').trim();
  var firstLine = text.split(/\r?\n/)[0] || '';
  var forbiddenPatterns = [
    /OpenAI Codex/i,
    /User instructions:/i,
    /Staged diff:/i,
    /stream error:/i,
    /\bERROR:/i,
    /unexpected status \d+/i,
    /^-{8,}$/m,
    /^\[\d{4}-\d{2}-\d{2}T/m
  ];

  if (!text) {
    throw new Error('Codex returned an empty commit message.');
  }
  if (binding && text.indexOf('Issue: ' + binding.issue) < 0) {
    throw new Error('Generated commit message is missing required trailer: Issue: ' + binding.issue);
  }
  if (firstLine.length > 72) {
    throw new Error('Generated commit subject is longer than 72 characters: ' + firstLine);
  }
  for (var i = 0; i < forbiddenPatterns.length; i++) {
    if (forbiddenPatterns[i].test(text)) {
      throw new Error('Generated commit message looks like Codex logs instead of a commit message. Aborting.');
    }
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

function printHelp() {
  console.log([
    'gmc - bind GitHub issues to AI coding sessions and commits',
    'git commit -m gmc - generate commit message with gmc hooks',
    'Usage:',
    '  gmc --version',
    '  gmc <issue> [--agent codex|claude] [--exec] [--no-branch]',
    '  gmc agent [codex|claude]',
    '  gmc bind <issue> [--agent codex|claude]',
    '  gmc status',
    '  gmc message [--print-prompt]',
    '  gmc commit [--no-edit]',
    '  gmc retry [commit]',
    '  gmc install --all [--port 4277]',
    '  gmc install-hooks',
    '  gmc web [--port 4277] [--no-open] [--start] [--restart] [--quit] [--watch]',
    '  git commit -m gmc',
    '',
    'Environment:',
    '  GITHUB_TOKEN or GH_TOKEN is used for GitHub API authentication.',
    '  GMC_CODEX_MODEL overrides the model used for commit message generation.',
    '  GMC_CODEX_TIMEOUT_MS overrides the Codex generation timeout.',
    '  GMC_GITWEB_PORT overrides the default local GitWeb port.',
    '  gmc install --all installs hooks and writes a repository-specific git.webloc.',
    '  gmc install-hooks sets up Git hooks for AI commit messages and task status updates.',
    '  gmc web serves the Git Web UI. If a server is already running, it will just open the current repository in the browser.',
    '  gmc web --start starts the Git Web UI in the background as a daemon.',
    '  gmc web --restart restarts the background Git Web UI daemon.',
    '  gmc web --quit stops the background Git Web UI daemon.',
    '  gmc web --watch restarts GitWeb when cli/lib/web.js changes and refreshes the browser.',
    'Examples:',
    '  git commit -m gmc',  // commit message generated by gmc hooks
    '  gmc agent claude',
    '  gmc GH-234 --agent codex',
    '  git add . && gmc message',
    '  git add . && gmc commit',
    '  gmc retry HEAD',
    '  gmc install --all',
    '  gmc install-hooks && git commit -m gmc',
    '  gmc web',
    '  gmc web --watch'
  ].join('\n'));
}
