import test from 'node:test';
import assert from 'node:assert';

// 1. AST Parser
function parse_search_query(query) {
  const terms = [];
  const regex = /(-)?(?:(domain|url|title):)?(?:"([^"]+)"|([^\s]+))/g;
  let match;
  while ((match = regex.exec(query)) !== null) {
    const is_negation = !!match[1];
    const field = match[2];
    const value = (match[3] || match[4])?.toLowerCase();
    if (value) terms.push({ is_negation, field, value });
  }
  return terms;
}

test('Edge Case: Unbalanced Quotes', () => {
  const terms = parse_search_query('domain:github.com "missing quote');
  // It should parse domain:github.com and then gracefully handle "missing quote
  assert.strictEqual(terms.length, 3); 
  assert.strictEqual(terms[0].value, 'github.com');
  assert.strictEqual(terms[1].value, '"missing');
  assert.strictEqual(terms[2].value, 'quote');
});

test('Edge Case: ReDoS (Long String)', () => {
  const start = Date.now();
  const longStr = 'a'.repeat(10000) + ' ' + 'domain:' + 'b'.repeat(10000);
  const terms = parse_search_query(longStr);
  const duration = Date.now() - start;
  assert.strictEqual(terms.length, 2);
  assert.ok(duration < 50, `Regex took too long: ${duration}ms, possible ReDoS vulnerability!`);
});

test('Edge Case: Empty or whitespace query', () => {
  assert.strictEqual(parse_search_query('').length, 0);
  assert.strictEqual(parse_search_query('    ').length, 0);
});

test('Edge Case: Just operators, no values', () => {
  const terms = parse_search_query('domain: title: -');
  assert.strictEqual(terms[0].value, 'domain:'); // Regex fallback behavior!
});

// 2. Web Worker simulation test
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';

test('Web Worker: Mocking browser environment to test training', async () => {
  // worker.js uses self.onmessage, which isn't 1-to-1 with node's worker_threads.
  // So we create a wrapper to run it in node.
  const code = `
    import { parentPort } from 'node:worker_threads';
    // Mock browser 'self'
    globalThis.self = {
      postMessage: (data) => parentPort.postMessage(data)
    };
    
    // Inject worker code dynamically
    import('./common/worker.js').then(module => {
      // Mock the incoming message
      parentPort.on('message', (data) => {
        self.onmessage({ data });
      });
    }).catch(err => parentPort.postMessage({ type: 'TRAIN_ERROR', error: err.message }));
  `;
  
  fs.writeFileSync('temp_worker_test.js', code);
  
  return new Promise((resolve, reject) => {
    const worker = new Worker('./temp_worker_test.js');
    
    // Simulate real decrypted groups payload
    const mockGroups = [{
      id: 'g1',
      tabs: [
        { title: 'Learn Machine Learning', url: 'https://ml.com' },
        { title: 'Neural Networks Guide', url: 'https://nn.com' }
      ]
    }];
    
    let gotVocab = false;
    let gotProgress = false;

    worker.on('message', (msg) => {
      if (msg.type === 'TRAIN_VOCAB') {
        gotVocab = true;
        assert.ok(msg.vocab_size > 0, 'Vocab should be built');
      } else if (msg.type === 'TRAIN_PROGRESS') {
        gotProgress = true;
        assert.ok(msg.progress.loss !== undefined, 'Loss should be reported');
      } else if (msg.type === 'TRAIN_COMPLETE') {
        assert.ok(gotVocab, 'Never received TRAIN_VOCAB');
        assert.ok(gotProgress, 'Never received TRAIN_PROGRESS');
        assert.ok(msg.serialized_state, 'Must return serialized model');
        worker.terminate();
        resolve();
      } else if (msg.type === 'TRAIN_ERROR') {
        worker.terminate();
        reject(new Error('Worker training failed: ' + msg.error));
      }
    });

    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error('Worker stopped with exit code ' + code));
    });

    // Start
    worker.postMessage({
      type: 'TRAIN_MODEL',
      payload: {
        decrypted_groups: mockGroups,
        epochs: 2,
        learning_rate: 0.05
      }
    });
  }).finally(() => {
    fs.unlinkSync('temp_worker_test.js');
  });
});
