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

  // forward pass: given an input word index, compute hidden layer
  // (the embedding lookup) and output layer activations (softmax scores)
  // returns { hidden: Float32Array, output: Float32Array }
  forward_pass(input_index) {
    let hidden = new Float32Array(this.embedding_dim);

    // lookup the embedding row for the input word
    let offset = input_index * this.embedding_dim;
    for (let d = 0; d < this.embedding_dim; d++) {
      hidden[d] = this.weights_input[offset + d];
    }

    // compute output scores: output[j] = sum(hidden[d] * W2[d][j])
    let output = new Float32Array(this.vocab_size);
    for (let j = 0; j < this.vocab_size; j++) {
      let sum = 0;
      for (let d = 0; d < this.embedding_dim; d++) {
        sum += hidden[d] * this.weights_output[d * this.vocab_size + j];
      }
      output[j] = sum;
    }

    // softmax to get probabilities
    let max_val = output[0];
    for (let j = 1; j < this.vocab_size; j++) {
      if (output[j] > max_val) max_val = output[j];
    }
    let sum_exp = 0;
    for (let j = 0; j < this.vocab_size; j++) {
      output[j] = Math.exp(output[j] - max_val);
      sum_exp += output[j];
    }
    for (let j = 0; j < this.vocab_size; j++) {
      output[j] /= sum_exp;
    }

    return { hidden: hidden, output: output };
  }

  // backward pass: compute gradients and update weights using sgd
  // uses cross-entropy loss: loss = -log(output[target_index])
  backward_pass(input_index, target_index, learning_rate) {
    let { hidden, output } = this.forward_pass(input_index);

    // gradient of loss w.r.t. output: (output - target)
    // for one-hot target, this is just output[j] - 1 if j == target else output[j]
    let grad_output = new Float32Array(this.vocab_size);
    for (let j = 0; j < this.vocab_size; j++) {
      grad_output[j] = output[j];
    }
    grad_output[target_index] -= 1;

    // gradient of loss w.r.t. hidden layer
    // grad_hidden[d] = sum_j(grad_output[j] * W2[d][j])
    let grad_hidden = new Float32Array(this.embedding_dim);
    for (let d = 0; d < this.embedding_dim; d++) {
      let sum = 0;
      for (let j = 0; j < this.vocab_size; j++) {
        sum += grad_output[j] * this.weights_output[d * this.vocab_size + j];
      }
      grad_hidden[d] = sum;
    }

    // update W2: W2[d][j] -= lr * grad_output[j] * hidden[d]
    for (let d = 0; d < this.embedding_dim; d++) {
      let h = hidden[d];
      for (let j = 0; j < this.vocab_size; j++) {
        this.weights_output[d * this.vocab_size + j] -= learning_rate * grad_output[j] * h;
      }
    }

    // update W1: W1[input][d] -= lr * grad_hidden[d]
    let offset = input_index * this.embedding_dim;
    for (let d = 0; d < this.embedding_dim; d++) {
      this.weights_input[offset + d] -= learning_rate * grad_hidden[d];
    }

    // return the loss for monitoring
    return -Math.log(output[target_index] + 1e-10);
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

    // initialize weights if not done yet
    if (!this.weights_input || this.weights_input.length === 0) {
      this.initialize_weights(this.vocab_size, this.embedding_dim);
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

  // fine-tune on new tabs using only tokens already in the vocabulary.
  // does NOT call create_training_dataset to avoid clearing the vocab.
  fine_tune_on_new_tabs(new_tabs, on_complete) {
    if (!this.weights_input || this.vocab_size === 0) {
      if (on_complete) on_complete();
      return;
    }

    // generate skip-gram pairs using only known vocabulary tokens
    let pairs = [];
    let window_size = 2;

    for (const tab of new_tabs) {
      let tokens = tokenize(tab.title + ' ' + (tab.url || ''));
      let indices = tokens
        .map(t => this.vocab.get(t))
        .filter(idx => idx !== undefined);

      for (let i = 0; i < indices.length; i++) {
        for (let j = Math.max(0, i - window_size); j <= Math.min(indices.length - 1, i + window_size); j++) {
          if (i === j) continue;
          pairs.push([indices[i], indices[j]]);
        }
      }
    }

    if (pairs.length === 0) {
      if (on_complete) on_complete();
      return;
    }

    // run a small number of epochs at a lower learning rate
    this.train_epochs(pairs, 3, 0.01, null, on_complete);
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

  // serialize the model to a compact json object for storage
  serialize() {
    return {
      vocab: Array.from(this.vocab.entries()),
      reverse_vocab: this.reverse_vocab,
      vocab_size: this.vocab_size,
      embedding_dim: this.embedding_dim,
      weights_input: Array.from(this.weights_input || []),
      weights_output: Array.from(this.weights_output || []),
      loss_history: this.loss_history,
      is_trained: this.is_trained
    };
  }

  // restore the model from a serialized json object
  deserialize(data) {
    this.vocab = new Map(data.vocab);
    this.reverse_vocab = data.reverse_vocab || [];
    this.vocab_size = data.vocab_size || 0;
    this.embedding_dim = data.embedding_dim || 64;
    this.weights_input = new Float32Array(data.weights_input || []);
    this.weights_output = new Float32Array(data.weights_output || []);
    this.loss_history = data.loss_history || [];
    this.is_trained = data.is_trained || false;
  }
}

export { LocalTabEmbedder, tokenize, calculate_cosine_similarity, kmeans_cluster };
