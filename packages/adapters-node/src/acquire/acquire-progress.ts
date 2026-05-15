/** 单视频采集子步骤进度（`prepareYoutubeVideo`）。 */
export type AcquireProgressCallbacks = {
  onStepStart?: (stepKey: string) => void;
  onStepEnd?: (stepKey: string, durationMs: number) => void;
};

/** 多视频采集子步骤进度（`executeNativeAcquire`）。 */
export type AcquireSubStepProgress = {
  onSubStepStart?: (videoId: string, stepKey: string) => void;
  onSubStepEnd?: (videoId: string, stepKey: string, durationMs: number) => void;
};
