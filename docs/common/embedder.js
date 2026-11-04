// local_tab_embedder: a from-scratch neural network for learning
// word embeddings (word2vec skip-gram style) on decrypted tab data.
// no external libraries. pure javascript matrix math.
// designed to run inside a chrome extension without freezing the ui.

// tokenize a string into lowercase word tokens
// strips punctuation and splits on whitespace
function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0);
}

// compute cosine similarity between two vectors using raw dot product and magnitude
function calculate_cosine_similarity(vector_a, vector_b) {
  let dot_product = 0;
  let magnitude_a = 0;
  let magnitude_b = 0;

  for (let i = 0; i < vector_a.length; i++) {
    dot_product += vector_a[i] * vector_b[i];
    magnitude_a += vector_a[i] * vector_a[i];
    magnitude_b += vector_b[i] * vector_b[i];
  }

  magnitude_a = Math.sqrt(magnitude_a);
  magnitude_b = Math.sqrt(magnitude_b);

  if (magnitude_a === 0 || magnitude_b === 0) return 0;
  return dot_product / (magnitude_a * magnitude_b);
}

// k-means clustering on an array of embedding vectors
// returns an array of cluster assignments (one per input vector)
function kmeans_cluster(vectors, k, max_iterations) {
  if (!vectors || vectors.length === 0) return [];
  if (k <= 0) k = 1;
  if (k > vectors.length) k = vectors.length;
  if (!max_iterations) max_iterations = 50;

  const dim = vectors[0].length;

  // initialize centroids by picking k random distinct vectors
  let centroids = [];
  let used_indices = new Set();
  while (centroids.length < k && centroids.length < vectors.length) {
    let idx = Math.floor(Math.random() * vectors.length);
    if (!used_indices.has(idx)) {
      used_indices.add(idx);
      centroids.push([...vectors[idx]]);
    }
  }

  let assignments = new Array(vectors.length).fill(0);

  for (let iter = 0; iter < max_iterations; iter++) {
    let changed = false;

    // assign each vector to the nearest centroid
    for (let v = 0; v < vectors.length; v++) {
      let best_cluster = 0;
      let best_distance = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        // use negative cosine similarity as distance
        let sim = calculate_cosine_similarity(vectors[v], centroids[c]);
        let dist = 1 - sim;
        if (dist < best_distance) {
          best_distance = dist;
          best_cluster = c;
        }
      }
      if (assignments[v] !== best_cluster) {
        assignments[v] = best_cluster;
        changed = true;
      }
    }

    // update centroids to the mean of assigned vectors
    for (let c = 0; c < centroids.length; c++) {
      let sum = new Array(dim).fill(0);
      let count = 0;
      for (let v = 0; v < vectors.length; v++) {
        if (assignments[v] === c) {
          for (let d = 0; d < dim; d++) {
            sum[d] += vectors[v][d];
          }
          count++;
        }
      }
      if (count > 0) {
        for (let d = 0; d < dim; d++) {
          centroids[c][d] = sum[d] / count;
        }
      }
    }

    if (!changed) break;
  }

  return assignments;
}

// the main neural network class for learning tab embeddings
// uses skip-gram architecture: predict context words from a center word
// weights are stored as flat typed arrays for low gc pressure
class LocalTabEmbedder {
  constructor() {
    this.vocab = new Map();      // word -> index
    this.reverse_vocab = [];     // index -> word
    this.vocab_size = 0;
    this.embedding_dim = 64;
    this.weights_input = null;   // vocab_size x embedding_dim (flat Float32Array)
    this.weights_output = null;  // embedding_dim x vocab_size (flat Float32Array)
    this.loss_history = [];
    this.is_trained = false;
    this.training_progress = 0;
    // negative sampling: how many negative (non-context) words to score per
    // training pair. the original word2vec trick that makes per-step cost
    // O(k) instead of O(vocab_size). default matches what word2vec papers use.
    this.negative_sample_count = 10;
  }

  // initialize weight matrices using xavier initialization
  // stored as flat Float32Array to avoid creating temporary objects
  initialize_weights(vocab_size, embedding_dim) {
    this.vocab_size = vocab_size;
    this.embedding_dim = embedding_dim;

    // xavier init: scale = sqrt(1 / fan_in)
    let scale_in = Math.sqrt(1.0 / vocab_size);
    let scale_out = Math.sqrt(1.0 / embedding_dim);

    this.weights_input = new Float32Array(vocab_size * embedding_dim);
    this.weights_output = new Float32Array(embedding_dim * vocab_size);

    for (let i = 0; i < this.weights_input.length; i++) {
      this.weights_input[i] = (Math.random() * 2 - 1) * scale_in;
    }
    for (let i = 0; i < this.weights_output.length; i++) {
      this.weights_output[i] = (Math.random() * 2 - 1) * scale_out;
    }
  }

  // (re)initialize ONLY weights_output. used when we load a deserialized model
  // whose weights_output was intentionally not persisted (see serialize()).
  // a fresh Xavier-initialized output layer is all that's needed to resume
  // training — the input layer's learned embeddings are what we keep.
  initialize_output_weights() {
    const vsize = this.vocab_size;
    const dim = this.embedding_dim;
    if (vsize === 0 || dim === 0) {
      this.weights_output = null;
      return;
    }
    let scale_out = Math.sqrt(1.0 / dim);
    this.weights_output = new Float32Array(dim * vsize);
    for (let i = 0; i < this.weights_output.length; i++) {
      this.weights_output[i] = (Math.random() * 2 - 1) * scale_out;
    }
  }

  // look up the embedding row for a single word index.
  // this is the input->hidden step shared by the old and new training paths.
  // kept as its own helper so inference cosine math stays small and clear.
  lookup_hidden(input_index) {
    let hidden = new Float32Array(this.embedding_dim);
    let offset = input_index * this.embedding_dim;
    for (let d = 0; d < this.embedding_dim; d++) {
      hidden[d] = this.weights_input[offset + d];
    }
    return hidden;
  }

  // score the hidden vector against one word's output row.
  // output layout is [embedding_dim][vocab_size] (flat), so word j's row is
  // weights_output[d * vocab_size + j]. score = dot(hidden, row_j).
  score_word(hidden, word_index) {
    let sum = 0;
    for (let d = 0; d < this.embedding_dim; d++) {
      sum += hidden[d] * this.weights_output[d * this.vocab_size + word_index];
    }
    return sum;
  }

  // negative-sampling backward pass.
  // for one (center, context) training pair:
  //   - score the true context word; sigmoid(score) -> target 1
  //   - score `negative_sample_count` randomly picked other words; target 0
  //   - update only the touched output rows + the center input row
  // per-step cost is O(negative_sample_count) instead of O(vocab_size).
  // loss = sum_of( -log(sigmoid(positive)) , -log(sigmoid(-negative)) ).
  backward_pass(input_index, target_index, learning_rate) {
    const k = this.negative_sample_count;
    const vsize = this.vocab_size;

    let hidden = this.lookup_hidden(input_index);

    // sample k negative words uniformly at random, excluding the true
    // context word. dedupe so the same word isn't double-counted as both
    // positive and negative in one step. uniform (not freq^0.75 weighted)
    // sampling is an acceptable simplification per the plan.
    const negatives = [];
    const seen = new Set([target_index]);
    let attempts = 0;
    while (negatives.length < k && attempts < k * 4) {
      attempts++;
      const cand = Math.floor(Math.random() * vsize);
      if (!seen.has(cand)) {
        seen.add(cand);
        negatives.push(cand);
      }
    }
    // edge case: vocab tiny enough that we couldn't find k distinct negatives.
    // just use what we have — a tiny vocab means training is already trivial.

    // words to score this step: positive first, then negatives.
    const allIndices = [target_index, ...negatives];
    const nwords = allIndices.length;

    let total_loss = 0;
    // per-touched-word output gradients. we only touch the words in
    // allIndices, so this buffer is tiny (k+1) not vocab_size.
    const grad_output_for_word = new Float32Array(nwords);

    // step 1: forward + loss + grad for each touched word
    for (let wi = 0; wi < nwords; wi++) {
      const widx = allIndices[wi];
      const score = this.score_word(hidden, widx);
      // numerically-stable sigmoid
      const sig = 1.0 / (1.0 + Math.exp(-score));
      const target = wi === 0 ? 1 : 0;
      // cross-entropy for a single sigmoid output:
      //   pos  loss = -log(sig)
      //   neg  loss = -log(1 - sig) = -log(sigmoid(-score))
      // both collapse to: -log(sig) if pos, -log(1-sig) if neg
      const p = Math.max(sig, 1e-7);
      const q = Math.max(1.0 - sig, 1e-7);
      total_loss += wi === 0 ? -Math.log(p) : -Math.log(q);
      grad_output_for_word[wi] = sig - target;
    }

    // step 2: grad w.r.t. hidden = sum over touched words of
    //   grad_output_for_word[wi] * weights_output[:, allIndices[wi]]
    // we ONLY accumulate from the touched words, not all words (that's the
    // whole point of negative sampling).
    let grad_hidden = new Float32Array(this.embedding_dim);
    for (let wi = 0; wi < nwords; wi++) {
      const widx = allIndices[wi];
      const g = grad_output_for_word[wi];
      for (let d = 0; d < this.embedding_dim; d++) {
        grad_hidden[d] += g * this.weights_output[d * vsize + widx];
      }
    }

    // step 3: update weights_output rows for ONLY the touched words.
    // W2[d][widx] -= lr * grad_output_for_word[wi] * hidden[d]
    for (let wi = 0; wi < nwords; wi++) {
      const widx = allIndices[wi];
      const g = grad_output_for_word[wi];
      for (let d = 0; d < this.embedding_dim; d++) {
        this.weights_output[d * vsize + widx] -= learning_rate * g * hidden[d];
      }
    }

    // step 4: update weights_input row for the center word only.
    // W1[input_index][d] -= lr * grad_hidden[d]
    let offset = input_index * this.embedding_dim;
    for (let d = 0; d < this.embedding_dim; d++) {
      this.weights_input[offset + d] -= learning_rate * grad_hidden[d];
    }

    // return the loss for monitoring — divide by nwords for a per-word
    // average so the curve shape is comparable to the old per-pair cross-entropy.
    return total_loss / nwords;
  }

  // build vocabulary and training pairs from decrypted tab groups
  // uses a sliding context window (skip-gram pattern)
  // each tab title is tokenized and context pairs are generated
  create_training_dataset(tab_groups) {
    this.vocab.clear();
    this.reverse_vocab = [];
    let all_tokens = [];

    // collect all tokens from all tab titles and urls
    for (const group of tab_groups) {
      for (const tab of group.tabs) {
        let tokens = tokenize(tab.title + ' ' + tab.url);
        all_tokens.push(tokens);
        for (const t of tokens) {
          if (!this.vocab.has(t)) {
            this.vocab.set(t, this.reverse_vocab.length);
            this.reverse_vocab.push(t);
          }
        }
      }
    }

    this.vocab_size = this.reverse_vocab.length;
    if (this.vocab_size === 0) return [];

    // build skip-gram pairs: (center_word, context_word) within a window
    let pairs = [];
    let window_size = 2;

    for (const tokens of all_tokens) {
      for (let i = 0; i < tokens.length; i++) {
        let center_idx = this.vocab.get(tokens[i]);
        for (let j = Math.max(0, i - window_size); j <= Math.min(tokens.length - 1, i + window_size); j++) {
          if (i === j) continue;
          let context_idx = this.vocab.get(tokens[j]);
          pairs.push([center_idx, context_idx]);
        }
      }
    }

    return pairs;
  }

  // run training epochs on the dataset
  // chunks execution using setTimeout to avoid blocking the ui
  // calls on_progress callback with loss and epoch info
  train_epochs(dataset, epochs, learning_rate, on_progress, on_complete) {
    if (dataset.length === 0 || this.vocab_size === 0) {
      this.is_trained = false;
      if (on_complete) on_complete();
      return;
    }

    // initialize weights if not done yet.
    // two cases after a deserialize():
    //   - weights_input may be empty (no prior training) -> fully init both.
    //   - weights_input is loaded but weights_output was intentionally
    //     dropped on persist -> only re-init the output layer (Xavier).
    if (!this.weights_input || this.weights_input.length === 0) {
      if (this.vocab_size === 0 || this.embedding_dim === 0) {
        this.is_trained = false;
        if (on_complete) on_complete();
        return;
      }
      this.initialize_weights(this.vocab_size, this.embedding_dim);
    } else if (!this.weights_output || this.weights_output.length === 0) {
      this.initialize_output_weights();
    }

    this.loss_history = [];
    this.is_trained = false;
    this.training_progress = 0;

    let epoch = 0;
    let pair_index = 0;
    let epoch_loss = 0;
    let pairs_per_chunk = 200; // process 200 pairs per frame to avoid freezing
    let self = this;

    function train_chunk() {
      let processed = 0;
      while (processed < pairs_per_chunk && pair_index < dataset.length) {
        let [input_idx, target_idx] = dataset[pair_index];
        let loss = self.backward_pass(input_idx, target_idx, learning_rate);
        epoch_loss += loss;
        pair_index++;
        processed++;
      }

      // check if epoch is done
      if (pair_index >= dataset.length) {
        let avg_loss = epoch_loss / dataset.length;
        self.loss_history.push(avg_loss);
        epoch++;
        pair_index = 0;
        epoch_loss = 0;

        if (on_progress) {
          on_progress({
            epoch: epoch,
            total_epochs: epochs,
            loss: avg_loss,
            progress: epoch / epochs
          });
        }

        if (epoch >= epochs) {
          self.is_trained = true;
          self.training_progress = 1;
          if (on_complete) on_complete();
          return;
        }
      }

      // schedule next chunk
      setTimeout(train_chunk, 0);
    }

    train_chunk();
  }

  // extract a single embedding vector for a set of token indices
  // averages the input weight rows for all tokens
  extract_embedding(token_indices) {
    if (!this.weights_input || token_indices.length === 0) {
      return new Float32Array(this.embedding_dim);
    }

    let result = new Float32Array(this.embedding_dim);
    let count = 0;

    for (const idx of token_indices) {
      if (idx < 0 || idx >= this.vocab_size) continue;
      let offset = idx * this.embedding_dim;
      for (let d = 0; d < this.embedding_dim; d++) {
        result[d] += this.weights_input[offset + d];
      }
      count++;
    }

    if (count > 0) {
      for (let d = 0; d < this.embedding_dim; d++) {
        result[d] /= count;
      }
    }

    return result;
  }

  // get embedding for a raw text string by tokenizing and averaging
  embed_text(text) {
    let tokens = tokenize(text);
    let indices = tokens.map(t => this.vocab.get(t)).filter(idx => idx !== undefined);
    return this.extract_embedding(indices);
  }

  // suggest a semantic group name for a set of tabs.
  // computes the centroid embedding of all tabs, then finds the closest
  // vocabulary token by cosine similarity. returns the token as a
  // capitalized string, or null if the model is untrained or no match found.
  suggest_group_name(tabs) {
    if (!this.is_trained || !this.weights_input || this.vocab_size === 0) {
      return null;
    }
    if (!tabs || tabs.length === 0) return null;

    // tokens to exclude from naming: too generic, too short, or URL noise
    const stopwords = new Set([
      'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was',
      'has', 'have', 'had', 'not', 'but', 'all', 'can', 'her', 'his',
      'how', 'its', 'may', 'new', 'now', 'old', 'our', 'out', 'own',
      'say', 'she', 'too', 'use', 'way', 'who', 'will', 'you', 'your',
      'www', 'com', 'org', 'net', 'http', 'https', 'html', 'php', 'asp',
      'index', 'page', 'site', 'web', 'en', 'de', 'fr', 'es', 'it'
    ]);

    // compute centroid by averaging tab embeddings
    let centroid = new Float32Array(this.embedding_dim);
    let valid_count = 0;

    for (const tab of tabs) {
      const text = (tab.title || '') + ' ' + (tab.url || '');
      const embedding = this.embed_text(text);
      // check if the embedding is non-zero (at least one known token)
      let has_signal = false;
      for (let d = 0; d < this.embedding_dim; d++) {
        if (embedding[d] !== 0) { has_signal = true; break; }
      }
      if (!has_signal) continue;

      for (let d = 0; d < this.embedding_dim; d++) {
        centroid[d] += embedding[d];
      }
      valid_count++;
    }

    if (valid_count === 0) return null;
    for (let d = 0; d < this.embedding_dim; d++) {
      centroid[d] /= valid_count;
    }

    // find the vocabulary token closest to the centroid
    let best_word = null;
    let best_similarity = -Infinity;

    for (let idx = 0; idx < this.vocab_size; idx++) {
      const word = this.reverse_vocab[idx];

      // skip low-value tokens
      if (!word || word.length <= 2) continue;
      if (stopwords.has(word)) continue;
      if (/^\d+$/.test(word)) continue;

      const offset = idx * this.embedding_dim;
      let dot = 0, mag_a = 0, mag_b = 0;
      for (let d = 0; d < this.embedding_dim; d++) {
        const a = centroid[d];
        const b = this.weights_input[offset + d];
        dot += a * b;
        mag_a += a * a;
        mag_b += b * b;
      }
      mag_a = Math.sqrt(mag_a);
      mag_b = Math.sqrt(mag_b);
      if (mag_a === 0 || mag_b === 0) continue;

      const similarity = dot / (mag_a * mag_b);
      if (similarity > best_similarity) {
        best_similarity = similarity;
        best_word = word;
      }
    }

    if (!best_word || best_similarity < 0.1) return null;

    // capitalize first letter
    return best_word.charAt(0).toUpperCase() + best_word.slice(1);
  }

  // serialize the model to a compact json object for storage.
  // weights_input is quantized to int8 + one scale factor so the persisted
  // payload is much smaller than full-precision floats — inference quality
  // stays the same since extract_embedding/suggest_group_name only read
  // weights_input and round-trip within one scale step.
  // weights_output is intentionally NOT persisted: it's only used to resume
  // training, and deserialize() + train_epochs re-Xavier-initialize a fresh
  // one sized to the loaded vocab/dim. keeping it out of storage avoids a
  // second precision question that doesn't matter at inference time.
  serialize() {
    const wi = this.weights_input || new Float32Array(0);
    // scale = max(abs(all values)) / 127. guard against all-zero weights.
    let max_abs = 0;
    for (let i = 0; i < wi.length; i++) {
      const a = Math.abs(wi[i]);
      if (a > max_abs) max_abs = a;
    }
    const scale = max_abs > 0 ? max_abs / 127.0 : 1.0;
    const quantized = new Int8Array(wi.length);
    for (let i = 0; i < wi.length; i++) {
      // round to nearest, clamp to int8 range to be safe against fp drift
      let q = Math.round(wi[i] / scale);
      if (q > 127) q = 127;
      else if (q < -127) q = -127;
      quantized[i] = q;
    }
    return {
      vocab: Array.from(this.vocab.entries()),
      reverse_vocab: this.reverse_vocab,
      vocab_size: this.vocab_size,
      embedding_dim: this.embedding_dim,
      // int8-quantized weights. stored as a plain array (JSON has no Int8Array)
      // but values are guaranteed integers in [-127, 127].
      weights_input: {
        data: Array.from(quantized),
        scale: scale,
      },
      // intentionally omitted: weights_output
      loss_history: this.loss_history,
      is_trained: this.is_trained
    };
  }

  // restore the model from a serialized json object.
  // tolerates both the new quantized shape ({data, scale}) and the legacy
  // shape (plain number[]) so any model saved before this change still loads.
  // weights_output is left null — train_epochs reinitializes it on demand.
  deserialize(data) {
    this.vocab = new Map(data.vocab);
    this.reverse_vocab = data.reverse_vocab || [];
    this.vocab_size = data.vocab_size || 0;
    this.embedding_dim = data.embedding_dim || 64;

    if (data.weights_input && typeof data.weights_input === 'object' &&
        !Array.isArray(data.weights_input) && 'data' in data.weights_input) {
      // new quantized format: dequantize back to Float32Array.
      const q = data.weights_input.data;
      const scale = data.weights_input.scale;
      const reconstructed = new Float32Array(q.length);
      for (let i = 0; i < q.length; i++) {
        reconstructed[i] = q[i] * scale;
      }
      this.weights_input = reconstructed;
    } else {
      // legacy format: plain array of full-precision floats.
      this.weights_input = new Float32Array(data.weights_input || []);
    }

    // intentionally not restored — gets Xavier-initialized by train_epochs
    // the next time the user hits "Retrain / Train Model" on a loaded model.
    this.weights_output = null;
    this.loss_history = data.loss_history || [];
    this.is_trained = data.is_trained || false;
  }
}

export { LocalTabEmbedder, tokenize, calculate_cosine_similarity, kmeans_cluster };
