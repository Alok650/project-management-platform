/**
 * CJS-compatible stub for p-limit v6 (pure-ESM).
 * In tests we don't need real concurrency control — just execute the function immediately.
 */
const pLimit = (_concurrency) => {
  return (fn) => fn();
};

module.exports = pLimit;
module.exports.default = pLimit;
