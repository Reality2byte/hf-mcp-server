import { describe, expect, it } from 'vitest';
import { extractMarkdownSection } from './hf-fs-docs-sections.js';

describe('extractMarkdownSection', () => {
	it('extracts exact doc-builder marker sections', () => {
		const markdown = `# API

## ChromaPipeline[[diffusers.ChromaPipeline]]

Pipeline details.

#### encode_prompt[[diffusers.ChromaPipeline.encode_prompt]]

Method details.

## Next[[diffusers.Next]]

Next details.`;

		expect(extractMarkdownSection(markdown, 'diffusers.ChromaPipeline.encode_prompt')).toEqual({
			content: '#### encode_prompt[[diffusers.ChromaPipeline.encode_prompt]]\n\nMethod details.',
			heading: 'encode_prompt',
			match: 'marker',
		});
	});

	it('matches rendered heading anchors and ignores headings inside code fences', () => {
		const markdown = `# Guide

\`\`\`md
## Not a section
\`\`\`

## Loading from a single file

Useful content.

## Next

Other content.`;

		expect(extractMarkdownSection(markdown, 'loading-from-a-single-file')).toEqual({
			content: '## Loading from a single file\n\nUseful content.',
			heading: 'Loading from a single file',
			match: 'heading',
		});
		expect(extractMarkdownSection(markdown, 'not-a-section')).toBeUndefined();
	});

	it('matches normalized doc-builder web anchors', () => {
		const markdown = `# Utilities

## Streamers[[transformers.TextStreamer]]

Streamer details.

## Caches[[transformers.Cache]]

Cache details.`;

		expect(extractMarkdownSection(markdown, 'streamerstransformerstextstreamer')).toEqual({
			content: '## Streamers[[transformers.TextStreamer]]\n\nStreamer details.',
			heading: 'Streamers',
			match: 'heading',
		});
	});

	it('returns bounded context for symbols without their own source heading', () => {
		const before = 'earlier content\n'.repeat(500);
		const after = 'later content\n'.repeat(1_000);
		const markdown = `# Utilities\n\n## Streamers[[transformers.TextStreamer]]\n\n${before}Use TextIteratorStreamer here.\n${after}`;
		const section = extractMarkdownSection(markdown, 'transformers.TextIteratorStreamer');

		expect(section).toMatchObject({ heading: 'Streamers', match: 'symbol' });
		expect(section?.content).toContain('TextIteratorStreamer');
		expect(section?.content).not.toContain('# Utilities');
		expect(section?.content.length).toBeLessThan(13_000);
	});

	it('returns undefined for an unknown section', () => {
		expect(extractMarkdownSection('# Guide\n\nContent.', 'missing')).toBeUndefined();
	});
});
