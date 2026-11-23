const { CHBMAppleID } = require('./ipv4');
const MAX_RETRIES = 3;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function classifyAppleResult(result) {
  if (result?.status !== 'checked') return {
    status: 'unchecked', reason: result?.reason || 'network_or_service', retryable: result?.retryable === true
  };
  if (result.note === 'sai pass') return { status: 'invalid', reason: 'incorrect_credentials' };
  if (result.note === 'successfully') return { status: 'valid', reason: 'authenticated' };
  if (result.note === 'CHBM') return { status: 'valid', reason: 'additional_verification_required' };
  if (result.note === 'locked') return { status: 'unchecked', reason: 'account_locked' };
  return { status: 'unchecked', reason: 'unknown_response' };
}

async function checkLoginAppleID(email, password, proxy, options = {}) {
  const progress = options.retryState || {};
  const shouldRetry = options.shouldRetry || (() => true);
  progress.attempts ??= 0;
  while (progress.attempts < 1 + MAX_RETRIES) {
    if (progress.result?.retryable) {
      if (!shouldRetry()) return { ...progress.result, deferred: true };
      await delay(1000 * progress.attempts);
      if (!shouldRetry()) return { ...progress.result, deferred: true };
    }
    progress.attempts++;
    progress.result = classifyAppleResult(await CHBMAppleID(email, password, proxy || null));
    if (!progress.result.retryable) return progress.result;
  }
  return progress.result;
}

module.exports = { checkLoginAppleID, classifyAppleResult };
