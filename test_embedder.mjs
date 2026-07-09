// Phase 7.2: unit tests for common/embedder.js — existing public behavior.
// run with: node --test test_embedder.mjs
//
// covers the minimum cases from the plan:
//   - tokenize() handles punctuation, casing, whitespace
//   - calculate_cosine_similarity: 1.0 for identical non-zero, 0 for all-zero
//   - kmeans_cluster: returns k (or fewer) distinct labels, doesn't crash on 1-2 vectors
//   - end-to-end sanity: train a tiny embedder on made-up tab titles spanning
//     a few distinct topics, check same-topic titles end up more cosine-similar
//     to each other than to different-topic titles — a real check that training
//     actually learned something, not just that it ran without errors.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./common/embedder.js', import.meta.url), 'utf8');
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
const { LocalTabEmbedder, tokenize, calculate_cosine_similarity, kmeans_cluster } =
  await import(dataUrl);

describe('embedder.js — tokenize', () => {
  it('lowercases, strips punctuation, splits on whitespace', () => {
    assert.deepEqual(
      tokenize('Hello, World!  This is a TEST.'),
      ['hello', 'world', 'this', 'is', 'a', 'test']
    );
  });

  it('handles mixed punctuation and numbers', () => {
    assert.deepEqual(
      tokenize('GitHub PR #42: Fix N+1 query (was 300ms)'),
      ['github', 'pr', '42', 'fix', 'n', '1', 'query', 'was', '300ms']
    );
  });

  it('returns [] for empty / null / undefined input', () => {
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize(null), []);
    assert.deepEqual(tokenize(undefined), []);
  });

  it('collapses multiple spaces and tabs', () => {
    assert.deepEqual(
      tokenize('a\t\tb   c'),
      ['a', 'b', 'c']
    );
  });
});

describe('embedder.js — calculate_cosine_similarity', () => {
  it('returns 1.0 for two identical non-zero vectors', () => {
    assert.equal(calculate_cosine_similarity([1, 2, 3], [1, 2, 3]), 1.0);
  });

  it('returns 0 when either vector is all zeros', () => {
    assert.equal(calculate_cosine_similarity([1, 2, 3], [0, 0, 0]), 0);
    assert.equal(calculate_cosine_similarity([0, 0, 0], [1, 2, 3]), 0);
  });

  it('returns 0 for two all-zero vectors (no direction)', () => {
    assert.equal(calculate_cosine_similarity([0, 0, 0], [0, 0, 0]), 0);
  });

  it('is symmetric — sim(a,b) === sim(b,a)', () => {
    const a = [1, 0, 1];
    const b = [0, 1, 1];
    assert.equal(
      calculate_cosine_similarity(a, b),
      calculate_cosine_similarity(b, a)
    );
  });

  it('is in [-1, 1] for opposite vectors', () => {
    // exactly opposite direction = -1.0
    assert.equal(calculate_cosine_similarity([1, 0], [-1, 0]), -1.0);
  });
});

describe('embedder.js — kmeans_cluster', () => {
  it('returns exactly k distinct labels for clearly separable clusters', () => {
    // two clusters: ones near (1,0) and ones near (0,1)
    const vectors = [
      [1.0, 0.0],
      [0.9, 0.1],
      [0.8, 0.05],
      [0.0, 1.0],
      [0.1, 0.9],
      [0.05, 0.8],
    ];
    const labels = kmeans_cluster(vectors, 2, 50);
    assert.equal(labels.length, 6, 'one label per input vector');
    const distinct = new Set(labels);
    assert.ok(distinct.size === 2, `expected 2 distinct labels, got ${distinct.size}`);
  });

  it('gracefully handles fewer points than k', () => {
    const vectors = [[1, 2, 3]];
    const labels = kmeans_cluster(vectors, 5, 50);
    assert.equal(labels.length, 1);
    // with 1 point and k=5, k gets clamped down — only 1 label possible.
    assert.equal(new Set(labels).size, 1);
  });

  it('does not crash on 2 input vectors', () => {
    const vectors = [[1, 0], [0, 1]];
    const labels = kmeans_cluster(vectors, 2, 50);
    assert.equal(labels.length, 2);
    assert.ok(new Set(labels).size <= 2);
  });

  it('returns [] for empty input', () => {
    assert.deepEqual(kmeans_cluster([], 3, 50), []);
  });

  it('all points in one cluster get the same label when k=1', () => {
    const vectors = [[1, 0], [0, 1], [0.5, 0.5]];
    const labels = kmeans_cluster(vectors, 1, 50);
    assert.equal(labels.length, 3);
    assert.ok(new Set(labels).size === 1, 'k=1 means every vector in one cluster');
  });
});

describe('embedder.js — end-to-end training sanity', () => {
  it('trains briefly on varied tabs; same-topic titles are more similar than cross-topic', async () => {
    // a tiny corpus spanning 3 obviously different topics. the point is not
    // to get great embeddings — it's to confirm the network actually learns
    // *something* (same topic more cosine-similar than different topic),
    // which is a stronger check than "training didn't crash."
    const corpus = [
      { tabs: [
        { title: 'sourdough bread baking recipe', url: 'https://cooking.example.com/bread' },
        { title: 'no knead artisan flour loaves', url: 'https://baking.example.com/no-knead' },
        { title: 'feeding sourdough starter schedule', url: 'https://cooking.example.com/starter' },
      ]},
      { tabs: [
        { title: 'linear algebra eigenvectors matrix', url: 'https://math.example.com/linalg' },
        { title: 'vector space basis dimension', url: 'https://math.example.com/vectors' },
        { title: 'eigenvalues principal components', url: 'https://math.example.com/pca' },
      ]},
      { tabs: [
        { title: 'guitar chord progression lessons', url: 'https://music.example.com/guitar' },
        { title: 'piano scales arpeggios practice', url: 'https://music.example.com/piano' },
        { title: 'music theory intervals scales', url: 'https://music.example.com/theory' },
      ]},
    ];

    const e = new LocalTabEmbedder();
    e.embedding_dim = 16;
    e.negative_sample_count = 5;
    const dataset = e.create_training_dataset(corpus);
    assert.ok(dataset.length > 0, 'dataset must have training pairs');

    await new Promise((resolve) => {
      e.train_epochs(dataset, 20, 0.05, null, resolve);
    });
    assert.ok(e.is_trained, 'model should be marked trained');

    // pick pairs within-topic and across-topic, compare cosine similarity.
    // we don't require EVERY same-topic pair to beat EVERY cross-topic pair
    // (training is tiny + random init), but a clear majority should hold.
    const bread = [
      e.embed_text('sourdough bread baking recipe'),
      e.embed_text('no knead artisan flour loaves'),
    ];
    const math = [
      e.embed_text('linear algebra eigenvectors matrix'),
      e.embed_text('eigenvalues principal components'),
    ];
    const music = [
      e.embed_text('guitar chord progression lessons'),
      e.embed_text('piano scales arpeggios practice'),
    ];

    // same-topic sims
    const same = [
      calculate_cosine_similarity(bread[0], bread[1]),
      calculate_cosine_similarity(math[0], math[1]),
      calculate_cosine_similarity(music[0], music[1]),
    ];

    // cross-topic sims (one from each pair vs one from each other pair)
    const cross = [
      calculate_cosine_similarity(bread[0], math[0]),
      calculate_cosine_similarity(bread[0], music[0]),
      calculate_cosine_similarity(math[0], music[0]),
      calculate_cosine_similarity(bread[1], math[1]),
      calculate_cosine_similarity(bread[1], music[1]),
      calculate_cosine_similarity(math[1], music[1]),
    ];

    const sameAvg = same.reduce((a, b) => a + b, 0) / same.length;
    const crossAvg = cross.reduce((a, b) => a + b, 0) / cross.length;

    assert.ok(
      sameAvg > crossAvg,
      `same-topic avg sim (${sameAvg.toFixed(3)}) should be greater than ` +
        `cross-topic avg sim (${crossAvg.toFixed(3)})`
    );
  });

  it('serialize/deserialize round-trip preserves vocab and embedding shape', async () => {
    const e = new LocalTabEmbedder();
    e.embedding_dim = 8;
    const corpus = [
      { tabs: [{ title: 'hello world test', url: 'https://example.com/hello' }] },
    ];
    const ds = e.create_training_dataset(corpus);
    await new Promise((resolve) => {
      e.train_epochs(ds, 3, 0.05, null, resolve);
    });

    const serialized = e.serialize();
    const e2 = new LocalTabEmbedder();
    e2.deserialize(serialized);

    assert.equal(e2.vocab_size, e.vocab_size);
    assert.equal(e2.embedding_dim, e.embedding_dim);
    assert.deepEqual(e2.reverse_vocab, e.reverse_vocab);
    // vocab map round-trips
    for (const [word, idx] of e.vocab) {
      assert.equal(e2.vocab.get(word), idx, `vocab mismatch for "${word}"`);
    }
    // is_trained flag survives
    assert.equal(e2.is_trained, e.is_trained);
    // embedding for the same text on both models should be very close
    // (within quantization error — Phase 5.2 introduced int8 quantization,
    //  so we allow a tolerance of one scale step).
    const v1 = e.embed_text('hello world');
    const v2 = e2.embed_text('hello world');
    let maxErr = 0;
    for (let i = 0; i < v1.length; i++) {
      maxErr = Math.max(maxErr, Math.abs(v1[i] - v2[i]));
    }
    assert.ok(
      maxErr <= serialized.weights_input.scale + 1e-5,
      `embedding max error ${maxErr} exceeds one quantization scale step ` +
        `${serialized.weights_input.scale}`
    );
  });
});
