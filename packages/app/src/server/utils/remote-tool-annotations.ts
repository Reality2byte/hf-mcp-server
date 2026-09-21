/**
 * Remote tools can execute arbitrary upstream behavior. Unless this server can
 * independently verify an upstream tool's guarantees, advertise the
 * conservative MCP defaults explicitly so clients can present suitable
 * confirmation UI.
 */
export interface RemoteToolAnnotations {
	title: string;
	readOnlyHint: false;
	destructiveHint: true;
	idempotentHint: false;
	openWorldHint: true;
}

export function createRemoteToolAnnotations(title: string): RemoteToolAnnotations {
	return {
		title,
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	};
}
