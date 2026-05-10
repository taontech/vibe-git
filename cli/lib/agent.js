'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var codexExecHelpCache = null;
var DEFAULT_CODEX_TIMEOUT_MS = 10 * 60 * 1000;

function spawnInherited(command, args, cwd) {
  var result = childProcess.spawnSync(command, args, {
    cwd: cwd,
    stdio: 'inherit'
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(command + ' exited with status ' + result.status);
  }
}

function launchAgent(options) {
  var agent = options.agent || 'codex';
  var cwd = options.cwd || process.cwd();
  var prompt = options.prompt;

  if (options.dryRun) {
    process.stdout.write(prompt + '\n');
    return;
  }

  if (agent === 'codex') {
    if (options.execMode) {
      var result = childProcess.spawnSync('codex', ['exec', '--cd', cwd, '-'], {
        cwd: cwd,
        input: prompt,
        stdio: ['pipe', 'inherit', 'inherit']
      });
      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new Error('codex exited with status ' + result.status);
      }
    } else {
      spawnInherited('codex', ['--cd', cwd, prompt], cwd);
    }
    return;
  }

  if (agent === 'claude') {
    if (options.execMode) {
      spawnInherited('claude', ['-p', prompt], cwd);
    } else {
      spawnInherited('claude', [prompt], cwd);
    }
    return;
  }

  throw new Error('Unsupported agent: ' + agent + '. Use codex or claude.');
}

function generateCommitMessage(prompt, cwd) {
  var outputFile = path.join(os.tmpdir(), 'gmc-commit-message-' + Date.now() + '-' + process.pid + '.txt');
  var help = codexExecHelp();
  var timeoutMs = codexTimeoutMs();
  var args = [
    'exec',
    '--cd', cwd,
    '--sandbox', 'read-only',
    '--color', 'never'
  ];

  if (help.indexOf('--ignore-user-config') >= 0) {
    args.push('--ignore-user-config');
  }
  if (process.env.GMC_CODEX_MODEL) {
    args.push('--model', process.env.GMC_CODEX_MODEL);
  }
  if (help.indexOf('--output-last-message') >= 0) {
    args.push('--output-last-message', outputFile);
  }

  args.push('-');

  var result = childProcess.spawnSync('codex', args, {
    cwd: cwd,
    encoding: 'utf8',
    input: prompt,
    timeout: timeoutMs,
    killSignal: 'SIGTERM'
  });

  if (result.error) {
    removeOutputFile(outputFile);
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error('codex commit message generation timed out after ' + Math.round(timeoutMs / 1000) + 's');
    }
    throw result.error;
  }
  if (result.status !== 0) {
    removeOutputFile(outputFile);
    throw new Error('codex commit message generation failed with status ' + result.status + ': ' + commandOutput(result));
  }

  if (fs.existsSync(outputFile)) {
    var finalMessage = fs.readFileSync(outputFile, 'utf8');
    removeOutputFile(outputFile);
    return cleanCommitMessage(finalMessage);
  }

  return cleanCommitMessage(result.stdout);
}

function codexTimeoutMs() {
  var raw = process.env.GMC_CODEX_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_CODEX_TIMEOUT_MS;
  }
  var parsed = Number(raw);
  if (!isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CODEX_TIMEOUT_MS;
  }
  return Math.round(parsed);
}

function commandOutput(result) {
  var output = ((result.stderr || '') + '\n' + (result.stdout || '')).trim();
  if (!output) {
    return '(no stderr/stdout captured)';
  }
  if (output.length > 4000) {
    return output.slice(0, 4000) + '\n[output truncated by gmc]';
  }
  return output;
}

function removeOutputFile(outputFile) {
  try {
    fs.unlinkSync(outputFile);
  } catch (error) {
    // Best effort cleanup only.
  }
}

function codexExecHelp() {
  if (codexExecHelpCache !== null) {
    return codexExecHelpCache;
  }
  var result = childProcess.spawnSync('codex', ['exec', '--help'], {
    encoding: 'utf8'
  });
  codexExecHelpCache = (result.stdout || '') + (result.stderr || '');
  return codexExecHelpCache;
}

function cleanCommitMessage(message) {
  return String(message || '')
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim() + '\n';
}

module.exports = {
  launchAgent: launchAgent,
  generateCommitMessage: generateCommitMessage,
  codexTimeoutMs: codexTimeoutMs
};
