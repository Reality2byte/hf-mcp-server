export const GRADIO_IMAGE_FILTER_FLAG = 'NO_GRADIO_IMAGE_CONTENT' as const;

export interface ToolBehaviorFlags {
	stripGradioImages: boolean;
	enableHfFsWrite: boolean;
}
