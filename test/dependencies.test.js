const test = require('node:test');
const assert = require('node:assert/strict');
const { findLoop } = require('../src/dependencies');

test('no links, no loop', () => {
  assert.equal(findLoop(1, [2], []), null);
});

test('depending on itself is a loop', () => {
  assert.deepEqual(findLoop(1, [1], []), [1, 1]);
});

test('direct loop: 1 waits for 2 while 2 waits for 1', () => {
  assert.deepEqual(findLoop(1, [2], [[2, 1]]), [1, 2, 1]);
});

test('loop through other tasks names the whole path', () => {
  // 2 -> 3 -> 4 -> 1 already; making 1 wait for 2 closes the loop.
  assert.deepEqual(findLoop(1, [2], [[2, 3], [3, 4], [4, 1]]), [1, 2, 3, 4, 1]);
});

test('the task\'s own existing links are ignored, since saving replaces them', () => {
  // 1 -> 2 exists; replacing it with 1 -> 3 is fine even though 1 -> 2 -> ... is irrelevant.
  assert.equal(findLoop(1, [3], [[1, 2], [2, 3]]), null);
});

test('shared prerequisites (a diamond) are not a loop', () => {
  // 1 waits for 2 and 3; both wait for 4.
  assert.equal(findLoop(1, [2, 3], [[2, 4], [3, 4]]), null);
});

test('an existing unrelated loop elsewhere does not hang the search', () => {
  assert.equal(findLoop(1, [5], [[5, 6], [6, 5]]), null);
});
