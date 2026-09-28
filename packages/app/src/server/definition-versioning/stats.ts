import type { DefinitionVersioningStats } from '../../shared/definition-versioning-status.js';

function empty(): DefinitionVersioningStats {
	return {
		versionedLists: 0,
		versionedDiscoveries: 0,
		checkedCalls: 0,
		matched: 0,
		mismatched: 0,
		staleTools: 0,
		staleInstructions: 0,
		since: new Date().toISOString(),
	};
}

let stats = empty();

export function recordVersionedList(): void {
	stats.versionedLists++;
}

export function recordVersionedDiscovery(): void {
	stats.versionedDiscoveries++;
}

export function recordCheckedCall(stale: readonly ('tools' | 'instructions')[]): void {
	const now = new Date().toISOString();
	stats.checkedCalls++;
	stats.lastCheckedAt = now;
	if (stale.length === 0) {
		stats.matched++;
		return;
	}
	stats.mismatched++;
	stats.lastMismatchAt = now;
	if (stale.includes('tools')) stats.staleTools++;
	if (stale.includes('instructions')) stats.staleInstructions++;
}

export function definitionVersioningStats(): DefinitionVersioningStats {
	return { ...stats };
}

export function resetDefinitionVersioningStats(): void {
	stats = empty();
}
