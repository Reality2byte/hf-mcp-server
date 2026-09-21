import { beforeEach, describe, expect, it } from 'vitest';
import {
	getHfFsLiveMetrics,
	recordHfFsLiveMetrics,
	resetHfFsLiveMetricsForTests,
} from '../../../src/server/utils/hf-fs-live-metrics.js';

describe('hf_fs live metrics', () => {
	beforeEach(() => {
		resetHfFsLiveMetricsForTests();
	});

	it('aggregates completed and interrupted batches without raw operation data', () => {
		recordHfFsLiveMetrics({
			hfFsReportingSchema: 'hf_fs_batch_v1',
			hfFsBatchOutcome: 'partial',
			hfFsOperationsRequested: 3,
			hfFsOperationsCompleted: 3,
			hfFsOperationsSucceeded: 1,
			hfFsRequestErrorCount: 1,
			hfFsTargetErrorCount: 1,
			hfFsPolicyLimitErrorCount: 0,
			hfFsServiceErrorCount: 0,
			hfFsOperationErrorsJson: '[{"index":1,"code":"HF_FS_INVALID_ARGUMENT"}]',
		});
		recordHfFsLiveMetrics({
			hfFsReportingSchema: 'hf_fs_batch_v1',
			hfFsBatchOutcome: 'failed',
			hfFsOperationsRequested: 1,
			hfFsOperationErrorsJson: '[]',
		});

		expect(getHfFsLiveMetrics()).toEqual({
			reportingSchema: 'hf_fs_batch_v1',
			batches: {
				total: 2,
				complete: 0,
				partial: 1,
				noneSucceeded: 0,
				failed: 1,
				cancelled: 0,
			},
			operations: {
				completed: 3,
				succeeded: 1,
				requestErrors: 1,
				targetErrors: 1,
				policyLimitErrors: 0,
				serviceErrors: 0,
			},
			lastUpdated: expect.any(String),
		});
	});

	it('returns an isolated snapshot', () => {
		const snapshot = getHfFsLiveMetrics();
		snapshot.batches.total = 100;
		expect(getHfFsLiveMetrics().batches.total).toBe(0);
	});
});
