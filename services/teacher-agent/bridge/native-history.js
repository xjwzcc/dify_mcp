import crypto from 'node:crypto';

// Fully supplied items are replayed by value, not looked up by a resource-local
// ID. call_id remains intact: it associates tools with their results.
// Only ciphertexts explicitly identified by the host's signed v1 migration
// binding are omitted. Current native reasoning/compaction is never discarded.
export function portableNativeInput(items, legacyHashes = '') {
  const legacy = new Set(legacyHashes.split(',').filter(Boolean));
  return items.map(item => {
    if (!item || typeof item !== 'object' || item.type === 'item_reference') return item;
    const out = {...item};
    delete out.id;
    if (out.type === 'reasoning' && typeof out.encrypted_content === 'string' &&
        legacy.has(crypto.createHash('sha256').update(out.encrypted_content).digest('hex'))) {
      delete out.encrypted_content;
    }
    return out;
  });
}
