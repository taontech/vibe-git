'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var DEFAULT_QUICK_ACTIONS = [
  {
    id: 'terminal',
    name: 'Terminal',
    type: 'builtin',
    builtinId: 'terminal',
    icon: 'terminal',
    enabled: true
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    type: 'builtin',
    builtinId: 'opencode',
    icon: 'opencode',
    enabled: true
  },
  {
    id: 'claude',
    name: 'Claude',
    type: 'builtin',
    builtinId: 'claude',
    icon: 'claude',
    enabled: true
  },
  {
    id: 'codex',
    name: 'Codex',
    type: 'builtin',
    builtinId: 'codex',
    icon: 'codex',
    enabled: true
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    type: 'builtin',
    builtinId: 'antigravity',
    icon: 'antigravity',
    enabled: true
  },
  {
    id: 'open-ide',
    name: 'VS Code',
    type: 'builtin',
    builtinId: 'open-ide',
    icon: 'ide',
    enabled: true
  }
];

function configFilePath(customPath) {
  if (customPath && typeof customPath === 'string') {
    return customPath;
  }
  return path.join(os.homedir(), '.config', 'gmc', 'quick-actions.json');
}

function cloneAction(action) {
  var cloned = {
    id: String(action.id || ''),
    name: String(action.name || ''),
    type: String(action.type || 'app'),
    appPath: action.appPath ? String(action.appPath) : '',
    command: action.command ? String(action.command) : '',
    args: action.args ? String(action.args) : '',
    runInTerminal: Boolean(action.runInTerminal),
    icon: action.icon ? String(action.icon) : 'app',
    enabled: action.enabled !== false
  };
  if (action.builtinId) {
    cloned.builtinId = String(action.builtinId);
  }
  return cloned;
}

function getDefaultQuickActions() {
  return DEFAULT_QUICK_ACTIONS.map(cloneAction);
}

function readConfigFile(customPath) {
  var file = configFilePath(customPath);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    var raw = fs.readFileSync(file, 'utf8');
    var parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && Array.isArray(parsed.actions)) {
      return parsed.actions;
    }
    return null;
  } catch (error) {
    return null;
  }
}

function writeConfigFile(actions, customPath) {
  var file = configFilePath(customPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(actions, null, 2) + '\n');
  return actions;
}

function listQuickActions(options) {
  options = options || {};
  var stored = readConfigFile(options.configPath);
  if (!stored) {
    return getDefaultQuickActions();
  }
  return stored.map(cloneAction);
}

function saveQuickActions(actions, options) {
  options = options || {};
  if (!Array.isArray(actions)) {
    throw new TypeError('Actions must be an array');
  }
  var sanitized = actions.map(function (item, index) {
    if (!item || typeof item !== 'object') {
      throw new TypeError('Action item at index ' + index + ' must be an object');
    }
    var id = String(item.id || ('qa_' + Date.now() + '_' + index)).trim();
    var name = String(item.name || '').trim();
    if (!name) {
      name = 'Action ' + (index + 1);
    }
    var type = String(item.type || 'app').trim();
    var result = {
      id: id,
      name: name,
      type: type,
      appPath: item.appPath ? String(item.appPath).trim() : '',
      command: item.command ? String(item.command).trim() : '',
      args: item.args ? String(item.args).trim() : '',
      runInTerminal: Boolean(item.runInTerminal),
      icon: item.icon ? String(item.icon).trim() : 'app',
      enabled: item.enabled !== false
    };
    if (item.builtinId) {
      result.builtinId = String(item.builtinId).trim();
    }
    return result;
  });
  writeConfigFile(sanitized, options.configPath);
  return sanitized;
}

function resetQuickActions(options) {
  options = options || {};
  var defaults = getDefaultQuickActions();
  writeConfigFile(defaults, options.configPath);
  return defaults;
}

function chooseAppPath() {
  return new Promise(function (resolve, reject) {
    if (process.platform !== 'darwin') {
      return reject(new Error('Choosing applications is only supported on macOS.'));
    }
    var script = [
      'try',
      '  set chosenItem to (choose file of type {"com.apple.application-bundle", "app"} default location (path to applications folder) with prompt "请选择要添加的应用程序")',
      '  return POSIX path of chosenItem',
      'on error',
      '  return ""',
      'end try'
    ].join('\n');

    childProcess.execFile('osascript', ['-e', script], { encoding: 'utf8' }, function (error, stdout, stderr) {
      if (error) {
        return resolve({ canceled: true });
      }
      var appPath = (stdout || '').trim();
      if (!appPath) {
        return resolve({ canceled: true });
      }
      var base = path.basename(appPath);
      var appName = base.replace(/\.app$/i, '');
      resolve({
        canceled: false,
        path: appPath,
        name: appName
      });
    });
  });
}

function interpolatePlaceholders(str, repoRoot, branch) {
  str = String(str || '');
  return str
    .replace(/\{repo\}/gi, repoRoot)
    .replace(/\$REPO\b/g, repoRoot)
    .replace(/\{branch\}/gi, branch || '')
    .replace(/\$BRANCH\b/g, branch || '');
}

function parseCommandLineArgs(argString) {
  argString = (argString || '').trim();
  if (!argString) return [];
  var args = [];
  var regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  var match;
  while ((match = regex.exec(argString)) !== null) {
    if (match[1] !== undefined) {
      args.push(match[1]);
    } else if (match[2] !== undefined) {
      args.push(match[2]);
    } else {
      args.push(match[0]);
    }
  }
  return args;
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function launchCustomAction(action, repoRoot, branch, helpers) {
  repoRoot = path.resolve(repoRoot || process.cwd());
  helpers = helpers || {};
  var env = Object.assign({}, process.env);

  if (action.runInTerminal) {
    var cmdToRun = '';
    if (action.command) {
      var intCmd = interpolatePlaceholders(action.command, repoRoot, branch);
      var intArgs = interpolatePlaceholders(action.args, repoRoot, branch);
      cmdToRun = 'cd ' + shellQuote(repoRoot) + ' && ' + intCmd + (intArgs ? ' ' + intArgs : '');
    } else if (action.appPath) {
      var appTarget = interpolatePlaceholders(action.args || '{repo}', repoRoot, branch);
      cmdToRun = 'cd ' + shellQuote(repoRoot) + ' && open -a ' + shellQuote(action.appPath) + ' ' + appTarget;
    } else {
      throw new Error('No command or application path specified for this action');
    }
    if (typeof helpers.openTerminal === 'function') {
      return helpers.openTerminal(repoRoot, cmdToRun);
    }
    throw new Error('Terminal opener not configured');
  }

  // Not in terminal:
  if (action.type === 'app' || action.appPath) {
    if (process.platform === 'darwin') {
      var openArgs = ['-a', action.appPath];
      if (action.args && action.args.trim()) {
        var parsedArgs = parseCommandLineArgs(interpolatePlaceholders(action.args, repoRoot, branch));
        openArgs = openArgs.concat(parsedArgs);
      } else {
        openArgs.push(repoRoot);
      }
      var res = childProcess.spawnSync('open', openArgs, { env: env, encoding: 'utf8' });
      if (res.error || res.status !== 0) {
        var errMsg = (res.stderr || '').trim() || (res.error && res.error.message) || ('Exit code ' + res.status);
        throw new Error(errMsg || 'Failed to open application: ' + action.appPath);
      }
      return { status: 'ok', launched: action.name || action.appPath };
    } else {
      var proc = childProcess.spawn(action.appPath, parseCommandLineArgs(interpolatePlaceholders(action.args || '', repoRoot, branch)), {
        cwd: repoRoot,
        env: env,
        detached: true,
        stdio: 'ignore'
      });
      proc.unref();
      return { status: 'ok', launched: action.name || action.appPath };
    }
  }

  if (action.type === 'command' || action.command) {
    var cmd = interpolatePlaceholders(action.command, repoRoot, branch);
    var cmdArgs = parseCommandLineArgs(interpolatePlaceholders(action.args || '', repoRoot, branch));
    var execRes = childProcess.spawnSync(cmd, cmdArgs, { cwd: repoRoot, env: env, encoding: 'utf8' });
    if (execRes.error || execRes.status !== 0) {
      var err = (execRes.stderr || '').trim() || (execRes.error && execRes.error.message) || ('Exit code ' + execRes.status);
      throw new Error(err || 'Failed to execute command: ' + cmd);
    }
    return { status: 'ok', launched: action.name || cmd };
  }

  throw new Error('Invalid action configuration: missing appPath or command');
}

module.exports = {
  DEFAULT_QUICK_ACTIONS: DEFAULT_QUICK_ACTIONS,
  getDefaultQuickActions: getDefaultQuickActions,
  configFilePath: configFilePath,
  readConfigFile: readConfigFile,
  writeConfigFile: writeConfigFile,
  listQuickActions: listQuickActions,
  saveQuickActions: saveQuickActions,
  resetQuickActions: resetQuickActions,
  chooseAppPath: chooseAppPath,
  interpolatePlaceholders: interpolatePlaceholders,
  parseCommandLineArgs: parseCommandLineArgs,
  launchCustomAction: launchCustomAction
};
