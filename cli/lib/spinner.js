'use strict';

var readline = require('readline');

var DEFAULT_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
var WIN_FRAMES = ['-', '\\', '|', '/'];

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

function Spinner(options) {
  if (!(this instanceof Spinner)) {
    return new Spinner(options);
  }

  options = options || {};
  this.stream = options.stream || process.stderr;
  this.isTTY = Boolean(this.stream && this.stream.isTTY);
  this.useColor = supportsColor(this.stream);
  this.useUnicode = supportsUnicode();
  this.frames = options.frames || (this.useUnicode ? DEFAULT_FRAMES : WIN_FRAMES);
  this.interval = options.interval || 80;
  this.text = options.text || '';
  this.frameIndex = 0;
  this.timer = null;
  this.startTime = null;
  this.stopped = false;
  this.sigintHandler = null;
  this.exitHandler = null;
}

Spinner.prototype.start = function (text) {
  if (text) {
    this.text = text;
  }
  this.startTime = Date.now();
  this.stopped = false;

  if (!this.isTTY) {
    if (this.text) {
      this.stream.write(this.text + '\n');
    }
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

  // Hide terminal cursor
  this.stream.write('\x1b[?25l');
  this.render();

  this.timer = setInterval(function () {
    self.frameIndex = (self.frameIndex + 1) % self.frames.length;
    self.render();
  }, this.interval);

  if (this.timer.unref) {
    this.timer.unref();
  }

  return this;
};

Spinner.prototype.render = function () {
  if (!this.isTTY || this.stopped) {
    return;
  }

  var frameChar = this.frames[this.frameIndex];
  var frame = this.useColor ? '\x1b[36m' + frameChar + '\x1b[0m' : frameChar;
  var elapsedSec = Math.floor((Date.now() - this.startTime) / 1000);
  var elapsedText = ' (' + elapsedSec + 's)';
  if (this.useColor) {
    elapsedText = ' \x1b[90m' + elapsedText.trim() + '\x1b[0m';
  }

  var line = frame + ' ' + this.text + elapsedText;
  readline.cursorTo(this.stream, 0);
  this.stream.write(line);
  readline.clearLine(this.stream, 1);
};

Spinner.prototype.update = function (text) {
  this.text = text || '';
  if (this.isTTY && !this.stopped) {
    this.render();
  }
  return this;
};

Spinner.prototype.stop = function () {
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
    readline.cursorTo(this.stream, 0);
    readline.clearLine(this.stream, 0);
    // Restore cursor
    this.stream.write('\x1b[?25h');
  }

  return this;
};

Spinner.prototype.succeed = function (text) {
  var duration = this.startTime ? ((Date.now() - this.startTime) / 1000).toFixed(1) + 's' : '';
  this.stop();

  var symbol = this.useUnicode ? '✔' : '√';
  if (this.useColor) {
    symbol = '\x1b[32m' + symbol + '\x1b[0m';
  }

  var timeStr = duration ? ' (' + duration + ')' : '';
  if (timeStr && this.useColor) {
    timeStr = ' \x1b[90m' + timeStr.trim() + '\x1b[0m';
  }

  this.stream.write(symbol + ' ' + (text || this.text) + timeStr + '\n');
  return this;
};

Spinner.prototype.fail = function (text) {
  var duration = this.startTime ? ((Date.now() - this.startTime) / 1000).toFixed(1) + 's' : '';
  this.stop();

  var symbol = this.useUnicode ? '✖' : 'x';
  if (this.useColor) {
    symbol = '\x1b[31m' + symbol + '\x1b[0m';
  }

  var timeStr = duration ? ' (' + duration + ')' : '';
  if (timeStr && this.useColor) {
    timeStr = ' \x1b[90m' + timeStr.trim() + '\x1b[0m';
  }

  this.stream.write(symbol + ' ' + (text || this.text) + timeStr + '\n');
  return this;
};

module.exports = Spinner;
