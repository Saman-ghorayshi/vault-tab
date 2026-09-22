import { LocalTabEmbedder } from './embedder.js';

let embedder = new LocalTabEmbedder();

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  if (type === 'TRAIN_MODEL') {
    const { decrypted_groups, epochs = 20, learning_rate = 0.05, serialized_state } = payload;
    
    // Restore previous state if provided (e.g. vocab and weights)
    if (serialized_state) {
      embedder.deserialize(serialized_state);
    } else {
      embedder = new LocalTabEmbedder(); // fresh embedder if no state
    }

    try {
      const dataset = embedder.create_training_dataset(decrypted_groups);
      
      if (dataset.length === 0) {
        self.postMessage({ type: 'TRAIN_ERROR', error: 'No tokens found in tab data' });
        return;
      }

      self.postMessage({ type: 'TRAIN_VOCAB', vocab_size: embedder.vocab_size });

      embedder.train_epochs(dataset, epochs, learning_rate,
        (progress) => {
          self.postMessage({ 
            type: 'TRAIN_PROGRESS', 
            progress: {
              loss: progress.loss,
              epoch: progress.epoch,
              total_epochs: progress.total_epochs,
              loss_history: embedder.loss_history
            }
          });
        },
        () => {
          // Send back the trained model weights
          const new_serialized = embedder.serialize();
          self.postMessage({ 
            type: 'TRAIN_COMPLETE', 
            serialized_state: new_serialized,
            loss_history: embedder.loss_history
          });
        }
      );
    } catch (err) {
      self.postMessage({ type: 'TRAIN_ERROR', error: err.message });
    }
  }
};
