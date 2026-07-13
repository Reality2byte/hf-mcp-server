export const DISABLE_TOOLS_ENV = 'DISABLE_TOOLS';

export interface ToolState {
	disable(): void;
}

export function parseDisabledTools(value: string | undefined = process.env[DISABLE_TOOLS_ENV]): ReadonlySet<string> {
	return new Set(
		(value ?? '')
			.split(',')
			.map((name) => name.trim())
			.filter(Boolean)
	);
}

export function isToolDisabled(name: string, disabledTools = parseDisabledTools()): boolean {
	return disabledTools.has(name);
}

export function disabledToolCallName(
	request: unknown,
	disabledTools = parseDisabledTools()
): string | undefined {
	const body = request as { method?: unknown; params?: { name?: unknown } } | null;
	const name = body?.method === 'tools/call' ? body.params?.name : undefined;
	return typeof name === 'string' && disabledTools.has(name) ? name : undefined;
}

export function disableConfiguredTool(name: string, tool: ToolState, disabledTools = parseDisabledTools()): void {
	if (disabledTools.has(name)) {
		tool.disable();
	}
}

export function disabledToolMessage(name: string): string {
	return `Tool ${name} is disabled by server configuration`;
}
