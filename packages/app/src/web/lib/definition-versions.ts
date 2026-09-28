import type { DefinitionVersioningStatus } from '../../shared/definition-versioning-status.js';

/** Served only in definition-versions test mode (404 otherwise). */
export const DEFINITION_VERSIONS_STATUS_URL = '/api/definition-versions';

export const definitionVersionsFetcher = (url: string): Promise<DefinitionVersioningStatus> =>
	fetch(url).then((res) => {
		if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
		return res.json() as Promise<DefinitionVersioningStatus>;
	});
