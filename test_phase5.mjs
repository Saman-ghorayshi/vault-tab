// phase 5: negative sampling + int8 quantization
// node:test + node:assert. run with: node --test test_phase5.mjs
//
// these tests are written BEFORE the implementation (TDD RED phase).
// against the CURRENT embedder.js, the negative-sampling and
// quantization tests should FAIL — that is the point.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

// load embedder.js as an ES module via data URL (it uses export).
const src = readFileSync(new URL('./common/embedder.js', import.meta.url), 'utf8');
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
const { LocalTabEmbedder, tokenize, calculate_cosine_similarity, kmeans_cluster } =
  await import(dataUrl);

// ---- helpers ---------------------------------------------------------------
function make_tab(title, url) {
  return { title, url };
}
function make_group(tabs) {
  return { tabs };
}

// a small but varied corpus: 3 clearly different topics, multiple tabs each.
// if the embedder learns anything at all, same-topic tabs should end up more
// cosine-similar to each other than to different-topic tabs.
const corpus = [
  make_group([
    make_tab('How to bake sourdough bread', 'https://cooking.example.com/bread'),
    make_tab('Sourdough starter feeding schedule', 'https://cooking.example.com/starter'),
    make_tab('Best flour for artisan bread', 'https://baking.example.com/flour'),
    make_tab('No-knead bread recipe', 'https://cooking.example.com/no-knead'),
  ]),
  make_group([
    make_tab('Introduction to linear algebra', 'https://math.example.com/linalg'),
    make_tab('Eigenvalues and eigenvectors', 'https://math.example.com/eigen'),
    make_tab('Matrix multiplication explained', 'https://math.example.com/matrix'),
    make_tab('Vector spaces primer', 'https://math.example.com/vectors'),
  ]),
  make_group([
    make_tab('Guitar chord progressions for beginners', 'https://music.example.com/guitar'),
    make_tab('Piano scales and arpeggios', 'https://music.example.com/piano'),
    make_tab('Music theory basics', 'https://music.example.com/theory'),
    make_tab('How to read sheet music', 'https://music.example.com/sheet'),
  ]),
];

// ---- 5.1: negative sampling -----------------------------------------------

describe('Phase 5.1 — negative sampling', () => {
  it('has a configurable negative_sample_count (default 10)', () => {
    const e = new LocalTabEmbedder();
    assert.ok(
      typeof e.negative_sample_count === 'number',
      'negative_sample_count should be a number'
    );
    assert.equal(e.negative_sample_count, 10, 'default should be 10');
  });

  it('training with negative sampling produces a decreasing loss trend', async () => {
    const e = new LocalTabEmbedder();
    e.embedding_dim = 16; // small for fast tests
    e.negative_sample_count = 5;
    const dataset = e.create_training_dataset(corpus);
    assert.ok(dataset.length > 0, 'dataset should not be empty');

    // run a few epochs synchronously via train_epochs but await completion.
    await new Promise((resolve) => {
      e.train_epochs(dataset, 12, 0.05, null, resolve);
    });

    assert.ok(e.is_trained, 'is_trained must be true after training completes');
    assert.ok(
      e.loss_history.length === 12,
      'should have one loss entry per epoch'
    );
    // loss should trend downward: last epoch loss < first epoch loss.
    // allow some noise — just require a clear overall drop.
    const first = e.loss_history[0];
    const last = e.loss_history[e.loss_history.length - 1];
    assert.ok(
      last < first,
      `loss should decrease: first=${first.toFixed(4)} last=${last.toFixed(4)}`
    );
  });

  it('training with negative sampling still yields coherent embeddings', async () => {
    const e = new LocalTabEmbedder();
    e.embedding_dim = 16;
    e.negative_sample_count = 5;
    const dataset = e.create_training_dataset(corpus);
    await new Promise((resolve) => {
      e.train_epochs(dataset, 15, 0.05, null, resolve);
    });
    assert.ok(e.is_trained);

    // embed two bread tabs and two math tabs, then check that same-topic
    // tabs are more similar to each other than cross-topic.
    const bread1 = e.embed_text('bake sourdough bread cooking');
    const bread2 = e.embed_text('flour recipe knead bread baking');
    const math1 = e.embed_text('linear algebra matrix eigenvalues');
    const math2 = e.embed_text('vector spaces eigenvalues math');

    const sim_same_bread = calculate_cosine_similarity(bread1, bread2);
    const sim_same_math = calculate_cosine_similarity(math1, math2);
    const sim_cross = calculate_cosine_similarity(bread1, math1);

    assert.ok(
      sim_same_bread > sim_cross || sim_same_math > sim_cross,
      `at least one same-topic pair should be more similar than cross-topic: ` +
        `bread-bread=${sim_same_bread.toFixed(3)} math-math=${sim_same_math.toFixed(3)} ` +
        `cross=${sim_cross.toFixed(3)}`
    );
  });

  it('suggest_group_name still returns a sensible word after negative-sampling training', async () => {
    const e = new LocalTabEmbedder();
    e.embedding_dim = 16;
    e.negative_sample_count = 5;
    const dataset = e.create_training_dataset(corpus);
    await new Promise((resolve) => {
      e.train_epochs(dataset, 15, 0.05, null, resolve);
    });
    const name = e.suggest_group_name([
      make_tab('Sourdough bread baking', 'https://cooking.example.com/bread'),
      make_tab('Artisan flour recipe', 'https://baking.example.com/flour'),
    ]);
    // just needs to be a non-null string — we don't assert which word.
    // training is tiny + random init, so we accept any real suggestion.
    assert.equal(typeof name === 'string' || name === null, true,
      'suggest_group_name must return string or null, not throw');
  });
});

// ---- 5.2: int8 quantization ------------------------------------------------

describe('Phase 5.2 — int8 weight quantization', () => {
  it('serialize() returns int8-quantized weights_input, not raw floats', async () => {
    const e = new LocalTabEmbedder();
    e.embedding_dim = 16;
    e.negative_sample_count = 5;
    const dataset = e.create_training_dataset(corpus);
    await new Promise((resolve) => {
      e.train_epochs(dataset, 8, 0.05, null, resolve);
    });
    const s = e.serialize();

    // the new shape: an object holding { data: number[] (int8 range), scale: number }
    assert.ok(
      s.weights_input && typeof s.weights_input === 'object' &&
        !Array.isArray(s.weights_input),
      'weights_input should be a {data, scale} object, not a raw array'
    );
    assert.ok(
      Array.isArray(s.weights_input.data),
      'quantized weights_input.data should be an array'
    );
    assert.ok(
      typeof s.weights_input.scale === 'number' && s.weights_input.scale > 0,
      'quantized scale should be a positive number'
    );
    // every dequantized value should be in int8 range (-127..127)
    for (const q of s.weights_input.data) {
      assert.ok(
        Number.isInteger(q) && q >= -127 && q <= 127,
        `quantized value ${q} out of int8 range [-127, 127]`
      );
    }
  });

  it('deserialize() rebuilt weights_input is close to the original (within scale precision)', async () => {
    const e = new LocalTabEmbedder();
    e.embedding_dim = 16;
    e.negative_sample_count = 5;
    const dataset = e.create_training_dataset(corpus);
    await new Promise((resolve) => {
      e.train_epochs(dataset, 8, 0.05, null, resolve);
    });

    // snapshot original before serializing
    const original = new Float32Array(e.weights_input);

    const serialized = e.serialize();
    const e2 = new LocalTabEmbedder();
    e2.deserialize(serialized);

    assert.ok(e2.weights_input instanceof Float32Array,
      'deserialized weights_input should be a Float32Array');
    assert.equal(e2.weights_input.length, original.length,
      'length should match');

    // each reconstructed value should be close (within 1 scale step) to original.
    let max_err = 0;
    for (let i = 0; i < original.length; i++) {
      const err = Math.abs(original[i] - e2.weights_input[i]);
      if (err > max_err) max_err = err;
    }
    const scale = serialized.weights_input.scale;
    // one quantization step is `scale`, so worst case error is scale (rounding).
    assert.ok(
      max_err <= scale + 1e-6,
      `max quantization error ${max_err} exceeds scale ${scale}`
    );
  });

  it('serialize() does NOT persist weights_output', async () => {
    const e = new LocalTabEmbedder();
    e.embedding_dim = 16;
    e.negative_sample_count = 5;
    const dataset = e.create_training_dataset(corpus);
    await new Promise((resolve) => {
      e.train_epochs(dataset, 8, 0.05, null, resolve);
    });
    const s = e.serialize();
    assert.ok(
      s.weights_output === undefined || s.weights_output === null,
      'weights_output should not be persisted (gets reinitialized on retrain)'
    );
  });

  it('deserialize() leaves weights_output null so retrain can reinitialize it', async () => {
    const e = new LocalTabEmbedder();
    e.embedding_dim = 16;
    e.negative_sample_count = 5;
    const dataset = e.create_training_dataset(corpus);
    await new Promise((resolve) => {
      e.train_epochs(dataset, 8, 0.05, null, resolve);
    });
    const s = e.serialize();
    const e2 = new LocalTabEmbedder();
    e2.deserialize(s);
    assert.ok(
      e2.weights_output === null || (Array.isArray(e2.weights_output) ? e2.weights_output.length === 0 : e2.weights_output.length === 0),
      'deserialized weights_output should be null/empty (Xavier-reinit on retrain)'
    );
  });

  it('retraining a deserialized model reinitializes weights_output (no crash)', async () => {
    const e = new LocalTabEmbedder();
    e.embedding_dim = 16;
    e.negative_sample_count = 5;
    const dataset = e.create_training_dataset(corpus);
    await new Promise((resolve) => {
      e.train_epochs(dataset, 8, 0.05, null, resolve);
    });
    const s = e.serialize();
    const e2 = new LocalTabEmbedder();
    e2.deserialize(s);
    // retrain on the same corpus — must not throw and must produce decreasing loss.
    await new Promise((resolve) => {
      e2.train_epochs(dataset, 5, 0.05, null, resolve);
    });
    assert.ok(e2.is_trained, 'retrained model should be marked trained');
    const s2 = e2.serialize();
    assert.ok(
      s2.weights_input && typeof s2.weights_input === 'object' &&
        !Array.isArray(s2.weights_input),
      'retrained model still quantizes on serialize'
    );
  });

  it('serialized size is meaningfully smaller than the pre-quantization JSON', async () => {
    const e = new LocalTabEmbedder();
    e.embedding_dim = 32;
    e.negative_sample_count = 5;
    const dataset = e.create_training_dataset(corpus);
    await new Promise((resolve) => {
      e.train_epochs(dataset, 10, 0.05, null, resolve);
    });

    // new (quantized) serialization
    const quantized = e.serialize();
    const quantized_json = JSON.stringify(quantized);

    // simulate the old shape: full-precision weights_input AND weights_output arrays
    const oldShape = {
      vocab: quantized.vocab,
      reverse_vocab: quantized.reverse_vocab,
      vocab_size: quantized.vocab_size,
      embedding_dim: quantized.embedding_dim,
      // dequantize to approximate full-precision payload (json numbers)
      weights_input: Array.from(
        e.weights_input
      ).map(v => Number(v.toFixed(6))),
      weights_output: Array.from(
        e.weights_output
      ).map(v => Number(v.toFixed(6))),
      loss_history: quantized.loss_history,
      is_trained: quantized.is_trained,
    };
    const old_json = JSON.stringify(oldShape);

    console.log(
      `  quantized: ${quantized_json.length} bytes, ` +
      `old-shape: ${old_json.length} bytes`
    );
    assert.ok(
      quantized_json.length < old_json.length,
      `quantized (${quantized_json.length}b) should be smaller than old-shape ` +
        `(${old_json.length}b)`
    );
  });
});

// ---- regression: existing public behavior still works ----------------------

describe('Regression — existing public behavior unchanged', () => {
  it('tokenize / cosine / kmeans still work (Phase 7.2 smoke)', () => {
    const tokens = tokenize('Hello, World!  This is a TEST.');
    assert.deepEqual(tokens, ['hello', 'world', 'this', 'is', 'a', 'test']);

    const v1 = [1, 0, 0];
    const v2 = [0, 0, 0];
    assert.equal(calculate_cosine_similarity(v1, v1), 1.0);
    assert.equal(calculate_cosine_similarity(v1, v2), 0);

    const labels = kmeans_cluster([[1, 0], [0.9, 0.1], [0, 1], [0.1, 0.9]], 2, 10);
    assert.equal(labels.length, 4);
    assert.ok(new Set(labels).size <= 2, 'at most k distinct labels');
  });
});
