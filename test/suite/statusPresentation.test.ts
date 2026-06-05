import { strict as assert } from 'assert';
import {
  CI_STATUS,
  CHECK_CONCLUSION,
  REVIEW_DECISION,
  REVIEW_STATE,
  SYNC_STATE,
  workflowRunStyle,
  resolveStatusStyle,
} from '../../src/utils/statusPresentation';

describe('statusPresentation (single source for status -> icon/color, by domain)', () => {
  describe('CI_STATUS', () => {
    it('uses the conventional green/red/yellow + foreground quad', () => {
      assert.deepEqual(CI_STATUS.success, { icon: 'pass-filled', color: 'charts.green', label: 'CI passed' });
      assert.deepEqual(CI_STATUS.failure, { icon: 'error', color: 'charts.red', label: 'CI failed' });
      assert.equal(CI_STATUS.pending.color, 'charts.yellow');
      assert.equal(CI_STATUS.unknown.color, 'foreground');
    });
  });

  describe('CHECK_CONCLUSION', () => {
    it('maps GitHub check conclusions', () => {
      assert.equal(CHECK_CONCLUSION.SUCCESS.icon, 'pass-filled');
      assert.equal(CHECK_CONCLUSION.FAILURE.color, 'charts.red');
      assert.equal(CHECK_CONCLUSION.ERROR.color, 'charts.red');
      assert.equal(CHECK_CONCLUSION.ACTION_REQUIRED.color, 'charts.yellow');
      assert.equal(CHECK_CONCLUSION.SKIPPED.icon, 'debug-step-over');
    });
  });

  describe('REVIEW_DECISION vs REVIEW_STATE (distinct vocabularies)', () => {
    it('REVIEW_DECISION uses REVIEW_REQUIRED; REVIEW_STATE uses COMMENTED/PENDING/DISMISSED', () => {
      assert.ok('REVIEW_REQUIRED' in REVIEW_DECISION);
      assert.ok(!('COMMENTED' in REVIEW_DECISION));
      assert.equal(REVIEW_STATE.COMMENTED.label, 'commented');
      assert.equal(REVIEW_STATE.DISMISSED.icon, 'circle-slash');
      assert.equal(REVIEW_STATE.APPROVED.color, 'charts.green');
    });
  });

  describe('SYNC_STATE (status-bar codicon-in-text form)', () => {
    it('uses $(...) icons and human labels, no color', () => {
      assert.equal(SYNC_STATE.synced.icon, '$(database)');
      assert.equal(SYNC_STATE.auth_error.label, 'Login Required');
      assert.equal(SYNC_STATE.error.label, 'No DB Branch');
      assert.equal(SYNC_STATE.synced.color, undefined);
    });
  });

  describe('workflowRunStyle', () => {
    it('completed + success -> pass/green', () => {
      assert.deepEqual(workflowRunStyle('completed', 'success'), { icon: 'pass', color: 'charts.green' });
    });
    it('completed + failure -> error/red', () => {
      assert.deepEqual(workflowRunStyle('completed', 'failure'), { icon: 'error', color: 'charts.red' });
    });
    it('completed + other conclusion -> warning, foreground', () => {
      assert.deepEqual(workflowRunStyle('completed', 'timed_out'), { icon: 'warning', color: 'foreground' });
    });
    it('in_progress -> spinner; queued -> clock; unknown -> circle-outline', () => {
      assert.equal(workflowRunStyle('in_progress', '').icon, 'loading~spin');
      assert.equal(workflowRunStyle('queued', '').icon, 'clock');
      assert.equal(workflowRunStyle('weird', '').icon, 'circle-outline');
    });
    it('color is keyed off conclusion (cancelled -> yellow)', () => {
      assert.equal(workflowRunStyle('completed', 'cancelled').color, 'charts.yellow');
    });
  });

  describe('resolveStatusStyle', () => {
    it('returns the mapped entry when the key is present', () => {
      assert.equal(resolveStatusStyle(CI_STATUS, 'success', CI_STATUS.unknown), CI_STATUS.success);
    });
    it('returns the fallback for a missing or undefined key', () => {
      assert.equal(resolveStatusStyle(CI_STATUS, 'bogus', CI_STATUS.unknown), CI_STATUS.unknown);
      assert.equal(resolveStatusStyle(CI_STATUS, undefined, CI_STATUS.unknown), CI_STATUS.unknown);
    });
  });
});
