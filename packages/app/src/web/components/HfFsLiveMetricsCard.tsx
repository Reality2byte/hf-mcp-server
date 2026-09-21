import type { HfFsLiveMetricsResponse } from '../../shared/transport-metrics.js';
import { formatCompactNumber } from '../lib/dashboard-utils';
import { SectionHeader } from './DashboardPrimitives';
import { Badge } from './ui/badge';
import { Card, CardContent } from './ui/card';

interface HfFsLiveMetricsCardProps {
	metrics: HfFsLiveMetricsResponse;
}

function formatUpdated(timestamp: string): string {
	const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
	if (elapsedSeconds < 60) return 'just now';
	const elapsedMinutes = Math.floor(elapsedSeconds / 60);
	if (elapsedMinutes < 60) return `${elapsedMinutes.toString()}m ago`;
	const elapsedHours = Math.floor(elapsedMinutes / 60);
	return `${elapsedHours.toString()}h ago`;
}

export function HfFsLiveMetricsCard({ metrics }: HfFsLiveMetricsCardProps) {
	const operationErrors =
		metrics.operations.requestErrors +
		metrics.operations.targetErrors +
		metrics.operations.policyLimitErrors +
		metrics.operations.serviceErrors;
	const operationSuccessRate =
		metrics.operations.completed > 0 ? (metrics.operations.succeeded / metrics.operations.completed) * 100 : undefined;
	const nonCompleteBatches =
		metrics.batches.partial + metrics.batches.noneSucceeded + metrics.batches.failed + metrics.batches.cancelled;

	return (
		<Card>
			<CardContent className="space-y-4">
				<SectionHeader
					title="hf_fs live"
					description="Process-local batch and operation outcomes since this server started."
					aside={
						<Badge variant="outline">
							{metrics.lastUpdated ? `Updated ${formatUpdated(metrics.lastUpdated)}` : 'Waiting for first call'}
						</Badge>
					}
				/>
				<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
					<div className="rounded-xl border bg-muted/25 p-3">
						<p className="text-xs font-medium text-muted-foreground">Batches</p>
						<p className="mt-1 font-mono text-xl font-semibold">{formatCompactNumber(metrics.batches.total)}</p>
						<p className="mt-1 text-xs text-muted-foreground">
							{metrics.batches.complete} complete · {metrics.batches.partial} partial
						</p>
					</div>
					<div className="rounded-xl border bg-muted/25 p-3">
						<p className="text-xs font-medium text-muted-foreground">Completed operations</p>
						<p className="mt-1 font-mono text-xl font-semibold">{formatCompactNumber(metrics.operations.completed)}</p>
						<p className="mt-1 text-xs text-muted-foreground">
							{formatCompactNumber(metrics.operations.succeeded)} succeeded · {formatCompactNumber(operationErrors)}{' '}
							errors
						</p>
					</div>
					<div className="rounded-xl border bg-muted/25 p-3">
						<p className="text-xs font-medium text-muted-foreground">Operation success</p>
						<p className="mt-1 font-mono text-xl font-semibold">
							{operationSuccessRate === undefined ? '—' : `${operationSuccessRate.toFixed(1)}%`}
						</p>
						<p className="mt-1 text-xs text-muted-foreground">Completed operations only</p>
					</div>
					<div className="rounded-xl border bg-muted/25 p-3">
						<p className="text-xs font-medium text-muted-foreground">Non-complete batches</p>
						<p className="mt-1 font-mono text-xl font-semibold">{formatCompactNumber(nonCompleteBatches)}</p>
						<p className="mt-1 text-xs text-muted-foreground">
							{metrics.batches.noneSucceeded} zero-success · {metrics.batches.failed} failed ·{' '}
							{metrics.batches.cancelled} cancelled
						</p>
					</div>
				</div>
				<div className="flex flex-wrap gap-2 text-xs">
					<Badge variant="secondary">Request errors · {metrics.operations.requestErrors}</Badge>
					<Badge variant="secondary">Target errors · {metrics.operations.targetErrors}</Badge>
					<Badge variant="outline">Policy/limit · {metrics.operations.policyLimitErrors}</Badge>
					<Badge variant={metrics.operations.serviceErrors > 0 ? 'destructive' : 'outline'}>
						Service errors · {metrics.operations.serviceErrors}
					</Badge>
				</div>
			</CardContent>
		</Card>
	);
}
