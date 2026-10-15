import test from 'node:test';
import assert from 'node:assert';
import { AsyncMutex } from '../common/mutex.js';

// Exercises the REAL AsyncMutex from background.js (extracted to common/mutex.js
// so the service worker and the test suite share one implementation).

test('VULNERABILITY HUNT: Distributed Deadlock (Tab Crash)', async () => {
  const mutex = new AsyncMutex(50); // 50ms lease for test speed
  let tab2_acquired_lock = false;

  // Tab 1: acquires the lock, then "crashes" — never calls unlock.
  // The dead-man's-switch lease timeout is what must let Tab 2 in.
  const tab1_process = async () => {
    await mutex.lock();
    throw new Error('Tab 1 crashed unexpectedly!');
  };

  const tab2_process = async () => {
    const unlock = await mutex.lock();
    tab2_acquired_lock = true;
    unlock();
  };

  try { await tab1_process(); } catch (_) { /* expected crash */ }
  tab2_process();

  // lease is 50ms; 150ms is plenty for the force-unlock to fire
  await new Promise(r => setTimeout(r, 150));
  assert.strictEqual(
    tab2_acquired_lock,
    true,
    'DEADLOCK DETECTED! Lease timeout failed to force-unlock after a crashed holder.'
  );
});

test('AsyncMutex: normal lock/release hands off to the next waiter', async () => {
  const mutex = new AsyncMutex(5000);
  const order = [];

  const worker = async (name, delay) => {
    const unlock = await mutex.lock();
    order.push(`${name}:start`);
    await new Promise(r => setTimeout(r, delay));
    order.push(`${name}:end`);
    unlock();
  };

  await Promise.all([worker('a', 20), worker('b', 5), worker('c', 1)]);

  // strict alternation: each job's start follows the previous job's end
  assert.deepStrictEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
});
