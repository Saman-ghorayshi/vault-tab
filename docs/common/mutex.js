// AsyncMutex with a dead-man's-switch lease timeout.
// Shared by the background service worker (write queue) and the test
// suite, so the tests exercise the real class instead of a stale copy.

export class AsyncMutex {
  constructor(lease_ms = 5000) {
    this.queue = [];
    this.locked = false;
    this.lease_timeout = null;
    this.lease_ms = lease_ms;
    // set by aegis:acquire-lock so a crashed client's lease can be
    // released by its aegis:release-lock message
    this.current_unlock_fn = null;
  }
  lock() {
    return new Promise(resolve => {
      this.queue.push(resolve);
      this.dispatch();
    });
  }
  dispatch() {
    if (this.locked || this.queue.length === 0) return;
    this.locked = true;
    // Dead man's switch: if the holder crashes or hangs without
    // releasing, force-unlock so waiters are not locked out forever.
    this.lease_timeout = setTimeout(() => {
      console.warn('Mutex lease expired! Force unlocking to prevent deadlock.');
      this.unlock();
    }, this.lease_ms);
    this.queue.shift()(this.unlock.bind(this));
  }
  unlock() {
    if (this.lease_timeout) {
      clearTimeout(this.lease_timeout);
      this.lease_timeout = null;
    }
    this.locked = false;
    this.dispatch();
  }
}
