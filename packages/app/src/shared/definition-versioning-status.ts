/** Dashboard view of definition versioning (served only in test mode). */
export interface DefinitionVersioningStatus {
	/** False when DEFINITION_VERSIONING=off. */
	enabled: boolean;
	ttlMs: number;
	/** DEFINITION_VERSIONS_SALT (deploy-wide). */
	deploySalt: string;
	/** Runtime test salt, set from the dashboard or /api/definition-versions/salt. */
	testSalt: string;
	testSaltUpdatedAt?: string;
	/** JSON-RPC error code returned for a mismatch. */
	errorCode: number;
	stats: DefinitionVersioningStats;
}

/** Process-local counters since start (or since the last reset). */
export interface DefinitionVersioningStats {
	versionedLists: number;
	versionedDiscoveries: number;
	checkedCalls: number;
	matched: number;
	mismatched: number;
	staleTools: number;
	staleInstructions: number;
	lastCheckedAt?: string;
	lastMismatchAt?: string;
	since: string;
}
