'use strict';

var assert = require('assert');
var stream = require('stream');
var Spinner = require('../lib/spinner');

function createMockStream(isTTY) {
  var chunks = [];
  var mock = new stream.Writable({
    write: function (chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    }
  });
  mock.isTTY = Boolean(isTTY);
  mock.getOutput = function () {
    return chunks.join('');
  };
  mock.clear = function () {
    chunks = [];
  };
  return mock;
}

function run() {
  console.log('Testing spinner utility...');

  // 1. Instantiation
  var spinner1 = new Spinner();
  assert.ok(spinner1 instanceof Spinner, 'new Spinner should create instance');

  var spinner2 = Spinner();
  assert.ok(spinner2 instanceof Spinner, 'Spinner() without new should create instance');

  // 2. Non-TTY stream behavior
  var nonTtyStream = createMockStream(false);
  var nonTtySpinner = new Spinner({
    stream: nonTtyStream,
    text: 'Loading test'
  });

  nonTtySpinner.start();
  assert.ok(nonTtyStream.getOutput().indexOf('Loading test\n') !== -1, 'Non-TTY should print initial text with newline');

  nonTtyStream.clear();
  nonTtySpinner.succeed('Loaded successfully');
  assert.ok(nonTtyStream.getOutput().indexOf('Loaded successfully') !== -1, 'Non-TTY succeed should write message');

  nonTtyStream.clear();
  nonTtySpinner.fail('Failed test');
  assert.ok(nonTtyStream.getOutput().indexOf('Failed test') !== -1, 'Non-TTY fail should write message');

  // 3. TTY stream behavior
  var ttyStream = createMockStream(true);
  var ttySpinner = new Spinner({
    stream: ttyStream,
    text: 'Thinking',
    interval: 50
  });

  ttySpinner.start();
  assert.strictEqual(ttySpinner.stopped, false);
  // Should hide cursor
  assert.ok(ttyStream.getOutput().indexOf('\x1b[?25l') !== -1, 'TTY should hide cursor on start');

  ttySpinner.update('Still thinking');
  assert.strictEqual(ttySpinner.text, 'Still thinking');

  ttySpinner.succeed('Done thinking');
  assert.strictEqual(ttySpinner.stopped, true);
  // Should restore cursor
  assert.ok(ttyStream.getOutput().indexOf('\x1b[?25h') !== -1, 'TTY should restore cursor on succeed');
  assert.ok(ttyStream.getOutput().indexOf('Done thinking') !== -1, 'Output should contain success message');

  // 4. Double stop safety
  ttySpinner.stop();
  assert.strictEqual(ttySpinner.stopped, true);

  console.log('Spinner utility tests passed.');
}

run();
