'use strict';

var readline = require('readline');

var DEFAULT_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
var WIN_FRAMES = ['-', '\\', '|', '/'];
var PULSE_GLYPHS = ['*', '+', '*', '+'];

var STAGES = [
  { id: 1, label: 'Inspecting git staging area & diff topology' },
  { id: 2, label: 'Resolving issue binding & repository rules' },
  { id: 3, label: 'Agent neural reasoning & semantic analysis' },
  { id: 4, label: 'Conventional commit synthesis & validation' }
];

function supportsUnicode() {
  if (process.platform !== 'win32') {
    return true;
  }
  return Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.VSCODE_PID);
}

function supportsColor(stream) {
  if (process.env.NO_COLOR) {
    return false;
  }
  return Boolean(stream && stream.isTTY);
}

function stripAnsi(str) {
  return String(str || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function padRight(str, len) {
  var s = String(str || '');
  var visualLen = stripAnsi(s).length;
  if (visualLen >= len) {
    return s;
  }
  var padding = '';
  for (var i = 0; i < len - visualLen; i++) {
    padding += ' ';
  }
  return s + padding;
}

function truncateTo(str, maxLen) {
  var s = String(str || '');
  var plainLen = stripAnsi(s).length;
  if (plainLen <= maxLen) {
    return s;
  }

  var target = Math.max(0, maxLen - 3);
  var visible = 0;
  var out = '';
  var inAnsi = false;

  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (ch === '\x1b') {
      inAnsi = true;
      out += ch;
    } else if (inAnsi) {
      out += ch;
      if (/[a-zA-Z]/.test(ch)) {
        inAnsi = false;
      }
    } else {
      if (visible >= target) {
        break;
      }
      out += ch;
      visible++;
    }
  }

  return out + '...\x1b[0m';
}

function formatDuration(ms) {
  var sec = (Math.max(0, ms) / 1000).toFixed(1);
  return sec + 's';
}

function CommitHud(options) {
  if (!(this instanceof CommitHud)) {
    return new CommitHud(options);
  }

  options = options || {};
  this.stream = options.stream || process.stderr;
  this.isTTY = Boolean(this.stream && this.stream.isTTY);
  this.useColor = supportsColor(this.stream);
  this.useUnicode = supportsUnicode();
  this.frames = options.frames || (this.useUnicode ? DEFAULT_FRAMES : WIN_FRAMES);
  this.interval = options.interval || 80;

  this.root = options.root || process.cwd();
  this.branch = options.branch || 'main';
  this.selectedAgent = options.selectedAgent || 'codex';
  this.model = options.model || process.env.GMC_CODEX_MODEL || null;
  this.stagedSummary = options.stagedSummary || { filesCount: 0, additions: 0, deletions: 0, files: [] };
  this.binding = options.binding || null;

  this.currentStage = 1;
  this.startTime = null;
  this.timer = null;
  this.frameIndex = 0;
  this.stopped = false;
  this.renderedLinesCount = 0;

  this.thinkingLines = [];
  this.tokenUsage = null;
  this.lastAgentText = '';
  this.simulatedThoughtIndex = 0;
  this.lastSimulatedTick = 0;

  this.sigintHandler = null;
  this.exitHandler = null;
}

CommitHud.prototype.color = function (name, text) {
  if (!this.useColor) {
    return text;
  }
  var codes = {
    cyan: '\x1b[36m',
    cyanBold: '\x1b[1;36m',
    magenta: '\x1b[35m',
    magentaBold: '\x1b[1;35m',
    green: '\x1b[32m',
    greenBold: '\x1b[1;32m',
    yellow: '\x1b[33m',
    yellowBold: '\x1b[1;33m',
    red: '\x1b[31m',
    redBold: '\x1b[1;31m',
    whiteBold: '\x1b[1;37m',
    dim: '\x1b[90m',
    bold: '\x1b[1m',
    reset: '\x1b[0m'
  };
  return (codes[name] || '') + text + codes.reset;
};

CommitHud.prototype.generateCognitiveThoughts = function () {
  var thoughts = [
    'Parsing staged AST delta and file hunks...',
    'Inspecting diff topology for semantic changes...'
  ];

  if (this.stagedSummary.files && this.stagedSummary.files.length) {
    var primaryFile = this.stagedSummary.files[0];
    var fileName = primaryFile.path || primaryFile;
    thoughts.push('Analyzing primary changes in ' + fileName + ' (+' + (primaryFile.additions || 0) + ' / -' + (primaryFile.deletions || 0) + ')...');
    if (this.stagedSummary.files.length > 1) {
      thoughts.push('Correlating ' + this.stagedSummary.files.length + ' changed files across modules...');
    }
  }

  if (this.binding && this.binding.issue) {
    thoughts.push('Linking issue context ' + this.binding.issue + ' with conventional scope...');
  } else {
    thoughts.push('Evaluating conventional commit prefix (feat/fix/refactor/docs)...');
  }

  thoughts.push('Formulating imperative commit subject under 72 chars...');
  thoughts.push('Synthesizing structured rationale and bullet points...');
  return thoughts;
};

CommitHud.prototype.start = function () {
  this.startTime = Date.now();
  this.stopped = false;

  if (!this.isTTY) {
    this.printNonTtyBanner();
    return this;
  }

  var self = this;
  this.sigintHandler = function () {
    self.stop();
    process.exit(130);
  };
  this.exitHandler = function () {
    self.stop();
  };

  process.once('SIGINT', this.sigintHandler);
  process.once('exit', this.exitHandler);

  // Hide cursor
  this.stream.write('\x1b[?25l');
  this.render();

  this.timer = setInterval(function () {
    self.frameIndex = (self.frameIndex + 1) % self.frames.length;
    var now = Date.now();
    if (now - self.lastSimulatedTick > 1800) {
      self.simulatedThoughtIndex++;
      self.lastSimulatedTick = now;
    }
    self.render();
  }, this.interval);

  if (this.timer.unref) {
    this.timer.unref();
  }

  return this;
};

CommitHud.prototype.setStage = function (stageId) {
  this.currentStage = stageId;
  if (!this.isTTY) {
    var stage = STAGES[stageId - 1];
    if (stage) {
      this.stream.write('GMC [' + stageId + '/4] ' + stage.label + '\n');
    }
  }
};

CommitHud.prototype.updateAgentActivity = function (event) {
  if (!event) return;

  if (event.type === 'thinking') {
    var text = String(event.text || event.delta || '').trim();
    if (text) {
      var lines = text.split(/\r?\n/).filter(function (l) { return l.trim().length > 0; });
      for (var i = 0; i < lines.length; i++) {
        var clean = lines[i].replace(/^["'#*-\s]+/, '').trim();
        if (clean.length > 0 && this.thinkingLines.indexOf(clean) === -1) {
          this.thinkingLines.push(clean);
          if (this.thinkingLines.length > 6) {
            this.thinkingLines.shift();
          }
        }
      }
    }
  } else if (event.type === 'text') {
    this.lastAgentText = String(event.text || event.delta || '').trim();
  } else if (event.type === 'usage' && event.usage) {
    this.tokenUsage = event.usage;
  }
};

CommitHud.prototype.printNonTtyBanner = function () {
  this.stream.write('=== GMC Commit: ' + this.branch + ' using ' + this.selectedAgent + ' ===\n');
  if (this.stagedSummary.filesCount) {
    this.stream.write('Staged: ' + this.stagedSummary.filesCount + ' files (+' + this.stagedSummary.additions + ' / -' + this.stagedSummary.deletions + ')\n');
  }
  if (this.binding && this.binding.issue) {
    this.stream.write('Issue: ' + this.binding.issue + ' - ' + (this.binding.title || '') + '\n');
  }
};

CommitHud.prototype.buildHeaderLines = function (boxWidth) {
  var lines = [];
  var c = this.useUnicode ? {
    tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│'
  } : {
    tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|'
  };

  var titleTag = ' * GMC NEURAL COMMIT ';
  var titleStyled = this.color('cyanBold', titleTag);
  var headerH = '';
  var rightPaddingCount = Math.max(2, boxWidth - 3 - stripAnsi(titleTag).length);
  for (var i = 0; i < rightPaddingCount; i++) {
    headerH += c.h;
  }
  lines.push(this.color('cyan', c.tl + c.h) + titleStyled + this.color('cyan', headerH + c.tr));

  // Row 1: Branch & Engine
  var branchStr = this.color('dim', 'Branch: ') + this.color('whiteBold', this.branch);
  var engineStr = this.color('dim', 'Engine: ') + this.color('magentaBold', this.selectedAgent) +
    (this.model ? this.color('dim', ' (' + this.model + ')') : '');
  var row1 = ' ' + branchStr + '   ' + engineStr;
  lines.push(this.color('cyan', c.v) + padRight(row1, boxWidth - 2) + this.color('cyan', c.v));

  // Row 2: Staged files & Diff metrics
  var filesCount = this.stagedSummary.filesCount || 0;
  var adds = this.stagedSummary.additions || 0;
  var dels = this.stagedSummary.deletions || 0;
  var stagedStr = this.color('dim', 'Staged: ') +
    this.color('whiteBold', String(filesCount) + (filesCount === 1 ? ' file' : ' files')) + ' ' +
    this.color('green', '(+' + adds + ')') + ' ' +
    this.color('red', '(-' + dels + ')');
  if (this.stagedSummary.files && this.stagedSummary.files.length) {
    var fileNames = this.stagedSummary.files.slice(0, 2).map(function (f) {
      var p = f.path || f;
      return p.split('/').pop();
    }).join(', ');
    if (this.stagedSummary.files.length > 2) {
      fileNames += ' +' + (this.stagedSummary.files.length - 2) + ' more';
    }
    stagedStr += ' ' + this.color('dim', '* ' + fileNames);
  }
  lines.push(this.color('cyan', c.v) + padRight(' ' + stagedStr, boxWidth - 2) + this.color('cyan', c.v));

  // Row 3: Binding context if present
  if (this.binding && this.binding.issue) {
    var issueStr = this.color('dim', 'Context: ') +
      this.color('yellowBold', this.binding.issue) +
      (this.binding.title ? this.color('dim', ' (' + truncateTo(this.binding.title, 36) + ')') : '');
    lines.push(this.color('cyan', c.v) + padRight(' ' + issueStr, boxWidth - 2) + this.color('cyan', c.v));
  }

  // Bottom border
  var bottomH = '';
  for (var j = 0; j < boxWidth - 2; j++) {
    bottomH += c.h;
  }
  lines.push(this.color('cyan', c.bl + bottomH + c.br));

  return lines;
};

CommitHud.prototype.buildStageLines = function () {
  var lines = [];
  var frameChar = this.frames[this.frameIndex];
  var elapsedSec = formatDuration(Date.now() - this.startTime);

  for (var i = 0; i < STAGES.length; i++) {
    var stage = STAGES[i];
    var stageNum = '[' + stage.id + '/4]';
    var line = '';

    if (stage.id < this.currentStage) {
      // Completed stage
      var check = 'v';
      line = '  ' + this.color('greenBold', check) + ' ' +
        this.color('dim', stageNum) + ' ' +
        this.color('dim', stage.label);
    } else if (stage.id === this.currentStage) {
      // Active stage
      var spinner = this.color('cyanBold', frameChar);
      line = '  ' + spinner + ' ' +
        this.color('cyanBold', stageNum) + ' ' +
        this.color('whiteBold', stage.label) + ' ' +
        this.color('dim', '(' + elapsedSec + ')');
    } else {
      // Future stage
      var bullet = '-';
      line = '  ' + this.color('dim', bullet) + ' ' +
        this.color('dim', stageNum + ' ' + stage.label);
    }
    lines.push(line);
  }

  return lines;
};

CommitHud.prototype.buildThinkingBox = function (boxWidth) {
  var lines = [];
  var c = this.useUnicode ? {
    tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│'
  } : {
    tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|'
  };

  var headerTag = ' * AGENT REASONING STREAM ';
  var headerStyled = this.color('magentaBold', headerTag);
  var borderH = '';
  var padCount = Math.max(2, boxWidth - 5 - stripAnsi(headerTag).length);
  for (var i = 0; i < padCount; i++) {
    borderH += c.h;
  }
  lines.push('  ' + this.color('magenta', c.tl + c.h) + headerStyled + this.color('magenta', borderH + c.tr));

  // Determine what thinking lines to show
  var displayLines = [];
  if (this.thinkingLines.length > 0) {
    displayLines = this.thinkingLines.slice(-3);
  } else {
    // Generate dynamic cognitive thoughts based on diff
    var cognitive = this.generateCognitiveThoughts();
    var idx = this.simulatedThoughtIndex % cognitive.length;
    displayLines = [
      cognitive[idx],
      cognitive[(idx + 1) % cognitive.length]
    ];
  }

  var icon = '> ';
  for (var k = 0; k < displayLines.length; k++) {
    var rawLine = (k === 0 ? icon : '   ') + displayLines[k];
    var truncated = truncateTo(rawLine, boxWidth - 8);
    var styled = (k === 0 ? this.color('cyan', truncated) : this.color('dim', truncated));
    lines.push('  ' + this.color('magenta', c.v) + ' ' + padRight(styled, boxWidth - 6) + ' ' + this.color('magenta', c.v));
  }

  // Bottom frame
  var bottomH = '';
  for (var m = 0; m < boxWidth - 4; m++) {
    bottomH += c.h;
  }
  lines.push('  ' + this.color('magenta', c.bl + bottomH + c.br));

  return lines;
};

CommitHud.prototype.buildTelemetryBar = function () {
  var elapsed = formatDuration(Date.now() - this.startTime);
  var parts = [
    this.color('dim', 'Elapsed: ') + this.color('whiteBold', elapsed),
    this.color('dim', 'Agent: ') + this.color('magentaBold', this.selectedAgent)
  ];

  if (this.tokenUsage) {
    var totalTokens = this.tokenUsage.total_tokens ||
      ((this.tokenUsage.input_tokens || 0) + (this.tokenUsage.output_tokens || 0)) ||
      (this.tokenUsage.total || null);
    if (totalTokens) {
      parts.push(this.color('dim', 'Tokens: ') + this.color('cyanBold', String(totalTokens)));
    }
  }

  var pulseGlyph = PULSE_GLYPHS[Math.floor(this.frameIndex / 2) % PULSE_GLYPHS.length];
  var glyphStyled = this.color('cyanBold', pulseGlyph);
  return '  [ ' + glyphStyled + ' ] ' + parts.join(this.color('dim', ' | '));
};

CommitHud.prototype.render = function () {
  if (!this.isTTY || this.stopped) {
    return;
  }

  var cols = (this.stream && this.stream.columns) ? this.stream.columns : 80;
  var maxCols = Math.max(20, cols - 1);
  var boxWidth = Math.max(40, Math.min(cols - 2, 74));

  var outputLines = [];
  outputLines = outputLines.concat(this.buildHeaderLines(boxWidth));
  outputLines.push('');
  outputLines = outputLines.concat(this.buildStageLines());
  outputLines.push('');

  // Show thinking box during stage 3 (reasoning)
  if (this.currentStage >= 3) {
    outputLines = outputLines.concat(this.buildThinkingBox(boxWidth));
    outputLines.push('');
  }

  outputLines.push(this.buildTelemetryBar());

  // Prevent any line from wrapping past terminal width
  for (var i = 0; i < outputLines.length; i++) {
    outputLines[i] = truncateTo(outputLines[i], maxCols);
  }

  // Clear previous frame
  this.clearPreviousRender();

  // Draw current frame without trailing newline so cursor stays on last line
  this.stream.write(outputLines.join('\n'));
  this.renderedLinesCount = outputLines.length;
};

CommitHud.prototype.clearPreviousRender = function () {
  if (!this.isTTY || this.renderedLinesCount <= 0) {
    return;
  }
  for (var i = 0; i < this.renderedLinesCount; i++) {
    readline.cursorTo(this.stream, 0);
    readline.clearLine(this.stream, 0);
    if (i < this.renderedLinesCount - 1) {
      readline.moveCursor(this.stream, 0, -1);
    }
  }
  readline.cursorTo(this.stream, 0);
  this.renderedLinesCount = 0;
};

CommitHud.prototype.stop = function () {
  if (this.stopped) {
    return this;
  }
  this.stopped = true;

  if (this.timer) {
    clearInterval(this.timer);
    this.timer = null;
  }

  if (this.sigintHandler) {
    process.removeListener('SIGINT', this.sigintHandler);
    this.sigintHandler = null;
  }
  if (this.exitHandler) {
    process.removeListener('exit', this.exitHandler);
    this.exitHandler = null;
  }

  if (this.isTTY) {
    this.clearPreviousRender();
    // Restore cursor
    this.stream.write('\x1b[?25h');
  }

  return this;
};

CommitHud.prototype.succeed = function (details) {
  details = details || {};
  var duration = this.startTime ? formatDuration(Date.now() - this.startTime) : '';
  this.stop();

  var message = String(details.message || '').trim();
  var lines = message.split(/\r?\n/);
  var subject = lines[0] || '(no message generated)';
  var body = lines.slice(1).join('\n').trim();

  var cols = (this.stream && this.stream.columns) ? this.stream.columns : 80;
  var boxWidth = Math.max(40, Math.min(cols - 2, 74));

  var c = this.useUnicode ? {
    tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│'
  } : {
    tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|'
  };

  var headerTag = ' * GENERATED COMMIT MESSAGE ';
  var headerStyled = this.color('greenBold', headerTag);
  var borderH = '';
  var padCount = Math.max(2, boxWidth - 3 - stripAnsi(headerTag).length);
  for (var i = 0; i < padCount; i++) {
    borderH += c.h;
  }

  var card = [];
  card.push(this.color('green', c.tl + c.h) + headerStyled + this.color('green', borderH + c.tr));
  card.push(this.color('green', c.v) + padRight('', boxWidth - 2) + this.color('green', c.v));

  // Subject line (bold cyan or bold white)
  var subjectDisplay = '  ' + this.color('whiteBold', truncateTo(subject, boxWidth - 6));
  card.push(this.color('green', c.v) + padRight(subjectDisplay, boxWidth - 2) + this.color('green', c.v));

  // Optional body lines
  if (body) {
    card.push(this.color('green', c.v) + padRight('', boxWidth - 2) + this.color('green', c.v));
    var bodyLines = body.split(/\r?\n/).slice(0, 5);
    for (var k = 0; k < bodyLines.length; k++) {
      var bLine = '  ' + this.color('dim', truncateTo(bodyLines[k], boxWidth - 6));
      card.push(this.color('green', c.v) + padRight(bLine, boxWidth - 2) + this.color('green', c.v));
    }
  }

  card.push(this.color('green', c.v) + padRight('', boxWidth - 2) + this.color('green', c.v));

  // Footer inside card
  var footerStats = '  ' + this.color('dim', 'Agent: ') + this.color('magentaBold', this.selectedAgent) +
    this.color('dim', ' | Took: ') + this.color('whiteBold', duration) +
    this.color('dim', ' | Conventional: ') + this.color('greenBold', 'verified');
  card.push(this.color('green', c.v) + padRight(footerStats, boxWidth - 2) + this.color('green', c.v));

  var bottomH = '';
  for (var j = 0; j < boxWidth - 2; j++) {
    bottomH += c.h;
  }
  card.push(this.color('green', c.bl + bottomH + c.br));

  this.stream.write(card.join('\n') + '\n\n');
  return this;
};

CommitHud.prototype.committed = function (commitOutput) {
  var check = 'v';
  var banner = this.color('greenBold', check + ' Commit successfully applied to ' + this.branch);
  this.stream.write(banner + '\n');
  if (commitOutput) {
    var lines = String(commitOutput).trim().split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      this.stream.write('  ' + this.color('dim', lines[i]) + '\n');
    }
  }
  this.stream.write('\n');
};

CommitHud.prototype.fail = function (error) {
  var duration = this.startTime ? formatDuration(Date.now() - this.startTime) : '';
  this.stop();

  var cross = 'x';
  var msg = error ? (error.message || String(error)) : 'Unknown error';

  var lines = [
    this.color('redBold', cross + ' Failed to generate commit message using ' + this.selectedAgent + ' (' + duration + ')'),
    '  ' + this.color('red', msg),
    '  ' + this.color('dim', 'Hint: check network connectivity or run "gmc retry HEAD"')
  ];

  this.stream.write(lines.join('\n') + '\n\n');
  return this;
};

module.exports = CommitHud;
