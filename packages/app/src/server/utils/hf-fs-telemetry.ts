import {
	HF_FS_BATCH_MAX_OPERATIONS,
	hfFsErrorClass,
	type HfFsBatchExecutionItem,
	type HfFsErrorClass,
	type HfFsRecoveryError,
} from '@llmindset/hf-mcp';

export const HF_FS_REPORTING_SCHEMA = 'hf_fs_batch_v1' as const;

export type HfFsBatchOutcome = 'complete' | 'partial' | 'none_succeeded' | 'failed' | 'cancelled';

interface HfFsOperationErrorTelemetry {
	index: number;
	code: HfFsRecoveryError['code'];
	suggestedOperation?: HfFsRecoveryError['suggestedOperation'];
}

export interface HfFsQueryTelemetry {
	hfFsReportingSchema: typeof HF_FS_REPORTING_SCHEMA;
	hfFsBatchOutcome: HfFsBatchOutcome;
	hfFsOperationsRequested: number;
	hfFsOperationsCompleted?: number;
	hfFsOperationsSucceeded?: number;
	hfFsRequestErrorCount?: number;
	hfFsTargetErrorCount?: number;
	hfFsPolicyLimitErrorCount?: number;
	hfFsServiceErrorCount?: number;
	hfFsOperationErrorsJson: string;
}

export interface CompletedHfFsQueryTelemetry extends HfFsQueryTelemetry {
	hfFsOperationsCompleted: number;
	hfFsOperationsSucceeded: number;
	hfFsRequestErrorCount: number;
	hfFsTargetErrorCount: number;
	hfFsPolicyLimitErrorCount: number;
	hfFsServiceErrorCount: number;
}

const EMPTY_ERROR_COUNTS = {
	request: 0,
	target: 0,
	policy_limit: 0,
	service: 0,
} satisfies Record<HfFsErrorClass, number>;

export function summarizeCompletedHfFsBatch(
	requestedCount: number,
	items: readonly HfFsBatchExecutionItem[]
): CompletedHfFsQueryTelemetry {
	if (!Number.isSafeInteger(requestedCount) || requestedCount < 1 || requestedCount > HF_FS_BATCH_MAX_OPERATIONS) {
		throw new Error('Invalid hf_fs telemetry requested operation count');
	}
	if (items.length !== requestedCount) {
		throw new Error('Completed hf_fs telemetry requires one result per requested operation');
	}

	const errorCounts: Record<HfFsErrorClass, number> = { ...EMPTY_ERROR_COUNTS };
	const operationErrors: HfFsOperationErrorTelemetry[] = [];
	const observedIndexes = new Set<number>();
	let successCount = 0;

	for (const item of items) {
		if (
			!Number.isSafeInteger(item.index) ||
			item.index < 0 ||
			item.index >= requestedCount ||
			observedIndexes.has(item.index)
		) {
			throw new Error('Completed hf_fs telemetry requires unique in-range operation indexes');
		}
		observedIndexes.add(item.index);
		if (item.status === 'success') {
			successCount += 1;
			continue;
		}
		errorCounts[hfFsErrorClass(item.error.code)] += 1;
		operationErrors.push({
			index: item.index,
			code: item.error.code,
			...(item.error.suggestedOperation ? { suggestedOperation: item.error.suggestedOperation } : {}),
		});
	}

	const batchOutcome = successCount === requestedCount ? 'complete' : successCount === 0 ? 'none_succeeded' : 'partial';

	return {
		hfFsReportingSchema: HF_FS_REPORTING_SCHEMA,
		hfFsBatchOutcome: batchOutcome,
		hfFsOperationsRequested: requestedCount,
		hfFsOperationsCompleted: items.length,
		hfFsOperationsSucceeded: successCount,
		hfFsRequestErrorCount: errorCounts.request,
		hfFsTargetErrorCount: errorCounts.target,
		hfFsPolicyLimitErrorCount: errorCounts.policy_limit,
		hfFsServiceErrorCount: errorCounts.service,
		hfFsOperationErrorsJson: JSON.stringify(operationErrors),
	};
}

export function summarizeInterruptedHfFsBatch(
	requestedCount: number,
	outcome: Extract<HfFsBatchOutcome, 'failed' | 'cancelled'>
): HfFsQueryTelemetry {
	if (!Number.isSafeInteger(requestedCount) || requestedCount < 1 || requestedCount > HF_FS_BATCH_MAX_OPERATIONS) {
		throw new Error('Invalid interrupted hf_fs telemetry requested operation count');
	}
	return {
		hfFsReportingSchema: HF_FS_REPORTING_SCHEMA,
		hfFsBatchOutcome: outcome,
		hfFsOperationsRequested: requestedCount,
		hfFsOperationErrorsJson: '[]',
	};
}
