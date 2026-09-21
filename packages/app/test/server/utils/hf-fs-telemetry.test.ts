import { describe, expect, it } from 'vitest';
import type { HfFsBatchExecutionItem } from '@llmindset/hf-mcp';
import {
	HF_FS_REPORTING_SCHEMA,
	summarizeCompletedHfFsBatch,
	summarizeInterruptedHfFsBatch,
} from '../../../src/server/utils/hf-fs-telemetry.js';

function success(index: number): HfFsBatchExecutionItem {
	return {
		index,
		status: 'success',
		executionResult: {
			op: 'stat',
			uri: 'hf://models',
			exists: true,
			type: 'namespace',
		},
	};
}

function failure(
	index: number,
	code: 'HF_FS_INVALID_ARGUMENT' | 'HF_FS_NOT_FOUND' | 'HF_FS_IMAGE_CONTENT_DISABLED' | 'HF_FS_ATTACHMENT_INTEGRITY'
): HfFsBatchExecutionItem {
	return {
		index,
		status: 'error',
		error: {
			code,
			message: 'sensitive provider-derived detail',
			recovery: 'fixed recovery guidance',
			retryable: false,
			suggestedOperation: 'stat',
		},
	};
}

describe('hf_fs query telemetry', () => {
	it('summarizes a complete batch', () => {
		expect(summarizeCompletedHfFsBatch(2, [success(0), success(1)])).toEqual({
			hfFsReportingSchema: HF_FS_REPORTING_SCHEMA,
			hfFsBatchOutcome: 'complete',
			hfFsOperationsRequested: 2,
			hfFsOperationsCompleted: 2,
			hfFsOperationsSucceeded: 2,
			hfFsRequestErrorCount: 0,
			hfFsTargetErrorCount: 0,
			hfFsPolicyLimitErrorCount: 0,
			hfFsServiceErrorCount: 0,
			hfFsOperationErrorsJson: '[]',
		});
	});

	it('summarizes partial failures by stable class and bounded operation index', () => {
		const telemetry = summarizeCompletedHfFsBatch(5, [
			success(0),
			failure(1, 'HF_FS_INVALID_ARGUMENT'),
			failure(2, 'HF_FS_NOT_FOUND'),
			failure(3, 'HF_FS_IMAGE_CONTENT_DISABLED'),
			failure(4, 'HF_FS_ATTACHMENT_INTEGRITY'),
		]);

		expect(telemetry).toMatchObject({
			hfFsBatchOutcome: 'partial',
			hfFsOperationsRequested: 5,
			hfFsOperationsCompleted: 5,
			hfFsOperationsSucceeded: 1,
			hfFsRequestErrorCount: 1,
			hfFsTargetErrorCount: 1,
			hfFsPolicyLimitErrorCount: 1,
			hfFsServiceErrorCount: 1,
		});
		expect(JSON.parse(telemetry.hfFsOperationErrorsJson)).toEqual([
			{ index: 1, code: 'HF_FS_INVALID_ARGUMENT', suggestedOperation: 'stat' },
			{ index: 2, code: 'HF_FS_NOT_FOUND', suggestedOperation: 'stat' },
			{ index: 3, code: 'HF_FS_IMAGE_CONTENT_DISABLED', suggestedOperation: 'stat' },
			{ index: 4, code: 'HF_FS_ATTACHMENT_INTEGRITY', suggestedOperation: 'stat' },
		]);
		expect(telemetry.hfFsOperationErrorsJson).not.toContain('sensitive provider-derived detail');
		expect(telemetry.hfFsOperationErrorsJson).not.toContain('fixed recovery guidance');
	});

	it('distinguishes an all-classified-error batch from an interrupted batch', () => {
		expect(summarizeCompletedHfFsBatch(1, [failure(0, 'HF_FS_NOT_FOUND')])).toMatchObject({
			hfFsBatchOutcome: 'none_succeeded',
			hfFsOperationsCompleted: 1,
			hfFsOperationsSucceeded: 0,
			hfFsTargetErrorCount: 1,
		});
		expect(summarizeInterruptedHfFsBatch(3, 'failed')).toEqual({
			hfFsReportingSchema: HF_FS_REPORTING_SCHEMA,
			hfFsBatchOutcome: 'failed',
			hfFsOperationsRequested: 3,
			hfFsOperationErrorsJson: '[]',
		});
		expect(summarizeInterruptedHfFsBatch(3, 'cancelled')).toMatchObject({
			hfFsBatchOutcome: 'cancelled',
		});
	});

	it('rejects inconsistent completed-batch counts', () => {
		expect(() => summarizeCompletedHfFsBatch(2, [success(0)])).toThrow(
			'Completed hf_fs telemetry requires one result per requested operation'
		);
		expect(() => summarizeCompletedHfFsBatch(2, [success(0), success(0)])).toThrow(
			'Completed hf_fs telemetry requires unique in-range operation indexes'
		);
	});
});
