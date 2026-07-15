/** 单视频采集子步骤进度（`prepareYoutubeVideo`）。 */
export type AcquireProgressCallbacks = {
  onStepStart?: (stepKey: string) => void;
  onStepEnd?: (stepKey: string, durationMs: number) => void;
  /** 步骤内细粒度进度（detail 为人类可读描述，fraction ∈ [0,1]）。 */
  onStepProgress?: (stepKey: string, detail: string, fraction: number) => void;
};

/** 多视频采集子步骤进度（`executeNativeAcquire`）。 */
export type AcquireSubStepProgress = {
  onSubStepStart?: (videoId: string, stepKey: string) => void;
  onSubStepEnd?: (videoId: string, stepKey: string, durationMs: number) => void;
  /** 步骤内细粒度进度（detail 为人类可读描述，fraction ∈ [0,1]）。 */
  onSubStepProgress?: (videoId: string, stepKey: string, detail: string, fraction: number) => void;
};
