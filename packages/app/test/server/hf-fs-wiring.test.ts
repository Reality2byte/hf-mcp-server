import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { downloadFile, pathsInfo } from '@huggingface/hub';
import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createServerFactory } from '../../src/server/mcp-server.js';
import { McpApiClient } from '../../src/server/utils/mcp-api-client.js';
import type { TransportInfo } from '../../src/shared/transport-info.js';

const queryLoggerMocks = vi.hoisted(() => ({
	logToolQuery: vi.fn(),
	logGradioEvent: vi.fn(),
}));

vi.mock('@huggingface/hub', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@huggingface/hub')>();
	return {
		...actual,
		downloadFile: vi.fn(),
		pathsInfo: vi.fn(),
	};
});

vi.mock('../../src/server/utils/query-logger.js', () => queryLoggerMocks);

const transportInfo: TransportInfo = {
	transport: 'streamableHttpJson',
	port: 3000,
	defaultHfTokenSet: false,
	externalApiMode: false,
	stdioClient: null,
};

describe('hf_fs MCP wiring', () => {
	beforeEach(() => {
		vi.mocked(pathsInfo).mockReset();
		vi.mocked(downloadFile).mockReset();
		queryLoggerMocks.logToolQuery.mockReset();
		queryLoggerMocks.logGradioEvent.mockReset();
	});

	it('logs bounded operation errors and aggregate classes for a partial batch', async () => {
		const apiClient = new McpApiClient({ type: 'static' }, transportInfo);
		const { server } = await createServerFactory(apiClient)({}, { builtInTools: [], spaceTools: [] }, true, {});
		const client = new Client({ name: 'hf-fs-wiring-test', version: '1.0.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		try {
			await client.callTool({
				name: 'hf_fs',
				arguments: {
					operations: [
						{ cmd: 'stat', args: ['hf://bogus'] },
						{ cmd: 'stat', args: ['hf://models'] },
					],
				},
			});

			expect(queryLoggerMocks.logToolQuery).toHaveBeenCalledOnce();
			expect(queryLoggerMocks.logToolQuery.mock.calls[0]?.[3]).toMatchObject({
				totalResults: 2,
				resultsShared: 1,
				success: true,
				hfFsReportingSchema: 'hf_fs_batch_v1',
				hfFsBatchOutcome: 'partial',
				hfFsOperationsRequested: 2,
				hfFsOperationsCompleted: 2,
				hfFsOperationsSucceeded: 1,
				hfFsRequestErrorCount: 1,
				hfFsTargetErrorCount: 0,
				hfFsPolicyLimitErrorCount: 0,
				hfFsServiceErrorCount: 0,
				hfFsOperationErrorsJson: '[{"index":0,"code":"HF_FS_INVALID_ARGUMENT"}]',
			});
		} finally {
			await client.close();
			await server.close();
		}
	});

	it('logs an interrupted batch without inventing operation outcomes', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'image.png', type: 'file', size: 3 }]);
		vi.mocked(downloadFile).mockRejectedValueOnce(new Error('unexpected private provider detail'));
		const apiClient = new McpApiClient({ type: 'static' }, transportInfo);
		const { server } = await createServerFactory(apiClient)({}, { builtInTools: [], spaceTools: [] }, true, {});
		const client = new Client({ name: 'hf-fs-wiring-test', version: '1.0.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		try {
			const result = await client.callTool({
				name: 'hf_fs',
				arguments: {
					operations: [{ cmd: 'attach', args: ['hf://models/org/repo/image.png'] }],
				},
			});
			expect(result.isError).toBe(true);

			expect(queryLoggerMocks.logToolQuery).toHaveBeenCalledOnce();
			expect(queryLoggerMocks.logToolQuery.mock.calls[0]?.[3]).toMatchObject({
				success: false,
				hfFsReportingSchema: 'hf_fs_batch_v1',
				hfFsBatchOutcome: 'failed',
				hfFsOperationsRequested: 1,
				hfFsOperationErrorsJson: '[]',
				error: expect.any(Error),
			});
			expect(queryLoggerMocks.logToolQuery.mock.calls[0]?.[3]).not.toHaveProperty('hfFsOperationsCompleted');
			expect(queryLoggerMocks.logToolQuery.mock.calls[0]?.[3]).not.toHaveProperty('hfFsOperationsSucceeded');
		} finally {
			await client.close();
			await server.close();
		}
	});

	it('returns fixed recovery metadata for deterministic compatibility errors', async () => {
		const apiClient = new McpApiClient({ type: 'static' }, transportInfo);
		const factory = createServerFactory(apiClient);
		const { server } = await factory({}, { builtInTools: [], spaceTools: [] }, true, {});
		const client = new Client({ name: 'hf-fs-wiring-test', version: '1.0.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		try {
			const listedTool = (await client.listTools()).tools.find((tool) => tool.name === 'hf_fs');
			expect(listedTool?.outputSchema).toMatchObject({
				type: 'object',
				additionalProperties: false,
				required: ['results'],
			});
			expect(listedTool?.inputSchema).toMatchObject({
				type: 'object',
				additionalProperties: false,
				required: ['operations'],
				properties: {
					operations: {
						type: 'array',
						minItems: 1,
						maxItems: 30,
					},
				},
			});
			const result = await client.callTool({
				name: 'hf_fs',
				arguments: {
					operations: [{ cmd: 'ls', args: ['hf://models', '--sort', 'downloads'] }],
				},
			});
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toMatchObject({
				results: [
					{
						index: 0,
						status: 'error',
						error: {
							code: 'HF_FS_INVALID_ARGUMENT',
							retryable: false,
						},
					},
				],
			});
			expect(result.content).toEqual([
				{
					type: 'text',
					text: expect.stringMatching(
						/^## Operation 1\n\n\[HF_FS_INVALID_ARGUMENT\] EINVAL: sort is not supported.*\nRecovery:/
					),
				},
			]);

			const unsupported = await client.callTool({
				name: 'hf_fs',
				arguments: { operations: [{ cmd: 'find', args: ['hf://'] }] },
			});
			expect(unsupported.structuredContent).toMatchObject({
				results: [
					{
						index: 0,
						status: 'error',
						error: {
							code: 'HF_FS_UNSUPPORTED_OPERATION',
							retryable: false,
							suggestedOperation: 'search',
						},
					},
				],
			});

			const malformed = await client.callTool({
				name: 'hf_fs',
				arguments: {
					operations: [
						{ cmd: 'stat', args: ['hf://bogus'] },
						{ cmd: 'stat', args: ['hf://models'] },
					],
				},
			});
			expect(malformed.isError).not.toBe(true);
			expect(malformed.structuredContent).toMatchObject({
				results: [
					{
						index: 0,
						status: 'error',
						error: {
							code: 'HF_FS_INVALID_ARGUMENT',
							message: expect.stringContaining("Invalid URI type 'bogus'"),
							retryable: false,
						},
					},
					{
						index: 1,
						status: 'success',
						result: {
							op: 'stat',
							uri: 'hf://models',
							exists: true,
						},
					},
				],
			});

			const notAFile = await client.callTool({
				name: 'hf_fs',
				arguments: { operations: [{ cmd: 'cat', args: ['hf://models/org/repo'] }] },
			});
			expect(notAFile.structuredContent).toMatchObject({
				results: [
					{
						index: 0,
						status: 'error',
						error: {
							code: 'HF_FS_NOT_A_FILE',
							retryable: false,
							suggestedOperation: 'stat',
						},
					},
				],
			});
		} finally {
			await client.close();
			await server.close();
		}
	});

	it('returns successful and failed operations together in input order', async () => {
		vi.mocked(pathsInfo).mockRejectedValueOnce(new Error('EACCES: access to this gated repository is restricted.'));
		const apiClient = new McpApiClient({ type: 'static' }, transportInfo);
		const factory = createServerFactory(apiClient);
		const { server } = await factory({}, { builtInTools: [], spaceTools: [] }, true, {});
		const client = new Client({ name: 'hf-fs-wiring-test', version: '1.0.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		try {
			const result = await client.callTool({
				name: 'hf_fs',
				arguments: {
					operations: [
						{ cmd: 'stat', args: ['hf://models/org/gated/config.json'] },
						{ cmd: 'stat', args: ['hf://models'] },
					],
				},
			});
			expect(result.isError).not.toBe(true);
			expect(result.structuredContent).toMatchObject({
				results: [
					{
						index: 0,
						status: 'error',
						error: {
							code: 'HF_FS_ACCESS_DENIED',
							retryable: false,
						},
					},
					{
						index: 1,
						status: 'success',
						result: {
							op: 'stat',
							uri: 'hf://models',
							exists: true,
						},
					},
				],
			});
		} finally {
			await client.close();
			await server.close();
		}
	});

	it('transports an image block without structured bytes or applying the Gradio image flag', async () => {
		const opaqueBytes = Uint8Array.from([0, 255, 1, 2, 3]);
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'images/sample.PNG', type: 'file', size: opaqueBytes.length }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob([opaqueBytes]));

		const apiClient = new McpApiClient({ type: 'static' }, transportInfo);
		const { server } = await createServerFactory(apiClient)(
			{},
			{ builtInTools: ['hf_fs', 'NO_GRADIO_IMAGE_CONTENT'], spaceTools: [] },
			true,
			{}
		);
		const client = new Client({ name: 'hf-fs-wiring-test', version: '1.0.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		try {
			const result = await client.callTool({
				name: 'hf_fs',
				arguments: {
					operations: [{ cmd: 'attach', args: ['hf://models/org/repo/images/sample.PNG'] }],
				},
			});
			expect(result.isError).not.toBe(true);
			expect(result.structuredContent).toEqual({
				results: [
					{
						index: 0,
						status: 'success',
						result: {
							op: 'attach',
							uri: 'hf://models/org/repo/images/sample.PNG',
							path: 'images/sample.PNG',
							mime_type: 'image/png',
							bytes: opaqueBytes.length,
						},
					},
				],
			});
			expect(result.content).toEqual([
				{
					type: 'text',
					text: expect.stringContaining('# hf_fs attach'),
				},
				{
					type: 'image',
					data: Buffer.from(opaqueBytes).toString('base64'),
					mimeType: 'image/png',
				},
			]);
			expect(JSON.stringify(result.structuredContent)).not.toContain(Buffer.from(opaqueBytes).toString('base64'));
			expect(result.structuredContent).not.toHaveProperty('data');
			expect(pathsInfo).toHaveBeenCalledWith(expect.objectContaining({ fetch: expect.any(Function) }));
			expect(downloadFile).toHaveBeenCalledWith(expect.objectContaining({ fetch: expect.any(Function) }));
		} finally {
			await client.close();
			await server.close();
		}
	});

	it('returns stable attachment integrity recovery metadata for an inconsistent Blob stream', async () => {
		const cancel = vi.fn();
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'image.png', type: 'file', size: 2 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce({
			size: 2,
			stream: () =>
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(Uint8Array.from([1, 2, 3]));
					},
					cancel,
				}),
		} as unknown as Blob);

		const apiClient = new McpApiClient({ type: 'static' }, transportInfo);
		const { server } = await createServerFactory(apiClient)({}, { builtInTools: [], spaceTools: [] }, true, {});
		const client = new Client({ name: 'hf-fs-wiring-test', version: '1.0.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		try {
			const result = await client.callTool({
				name: 'hf_fs',
				arguments: { operations: [{ cmd: 'attach', args: ['hf://models/org/repo/image.png'] }] },
			});
			expect(result.structuredContent).toMatchObject({
				results: [
					{
						index: 0,
						status: 'error',
						error: {
							code: 'HF_FS_ATTACHMENT_INTEGRITY',
							retryable: false,
							suggestedOperation: 'stat',
						},
					},
				],
			});
			expect(result).toMatchObject({
				isError: true,
			});
			expect(cancel).toHaveBeenCalledOnce();
		} finally {
			await client.close();
			await server.close();
		}
	});

	it('rejects attach on the generic no-image header before stat and download', async () => {
		const apiClient = new McpApiClient({ type: 'static' }, transportInfo);
		const { server } = await createServerFactory(apiClient)(
			{ 'x-mcp-no-image-content': ' true ' },
			{ builtInTools: [], spaceTools: [] },
			true,
			{}
		);
		const client = new Client({ name: 'hf-fs-wiring-test', version: '1.0.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		try {
			const result = await client.callTool({
				name: 'hf_fs',
				arguments: { operations: [{ cmd: 'attach', args: ['hf://models/org/repo/image.png'] }] },
			});
			expect(result.structuredContent).toMatchObject({
				results: [
					{
						index: 0,
						status: 'error',
						error: {
							code: 'HF_FS_IMAGE_CONTENT_DISABLED',
							retryable: false,
							suggestedOperation: 'stat',
						},
					},
				],
			});
			expect(result).toMatchObject({
				isError: true,
			});
			expect(pathsInfo).not.toHaveBeenCalled();
			expect(downloadFile).not.toHaveBeenCalled();
		} finally {
			await client.close();
			await server.close();
		}
	});
});
