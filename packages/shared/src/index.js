export const RunStatus = Object.freeze({
  QUEUED: 'queued',
  PLANNING: 'planning',
  AWAITING_APPROVAL: 'awaiting_approval',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

export function slugify(input) {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
