import test from 'node:test';
import assert from 'node:assert';

// Simulate the Background Service Worker's Mutex State
class FlawedDistributedMutex {
  constructor() {
    this.queue = [];
    this.locked = false;
  }
  
  async acquire() {
    return new Promise(resolve => {
      this.queue.push(resolve);
      this.dispatch();
    });
  }
  
  dispatch() {
    if (this.locked || this.queue.length === 0) return;
    this.locked = true;
    this.queue.shift()();
  }
  
  release() {
    this.locked = false;
    this.dispatch();
  }
}

test('VULNERABILITY HUNT: Distributed Deadlock (Tab Crash)', async () => {
  const mutex = new FlawedDistributedMutex();
  let tab2_acquired_lock = false;

  // Tab 1: Acquires the lock, but "crashes" before releasing it
  const tab1_process = async () => {
    await mutex.acquire();
    // Simulate a fatal crash (e.g. user closes tab, or uncaught exception)
    throw new Error("Tab 1 crashed unexpectedly!");
    // mutex.release() is never called!
  };

  // Tab 2: Tries to acquire the lock after Tab 1
  const tab2_process = async () => {
    // Wait slightly to ensure Tab 1 gets the lock first
    await new Promise(r => setTimeout(r, 10)); 
    await mutex.acquire();
    tab2_acquired_lock = true;
    mutex.release();
  };

  // Run them concurrently
  try {
    await tab1_process();
  } catch (e) {
    // Expected crash
  }
  
  // Tab 2 is still running in the background, waiting for the lock
  tab2_process();
  
  // Wait enough time for Tab 2 to theoretically acquire it
  await new Promise(r => setTimeout(r, 50));
  
  assert.strictEqual(
    tab2_acquired_lock, 
    true, 
    "DEADLOCK DETECTED! Tab 2 is permanently locked out because Tab 1 crashed."
  );
});
