/**
 * SRT 时间戳 <-> 毫秒。
 *
 * 接受 "HH:MM:SS,mmm" 和 "MM:SS,mmm" 两种写法，小数点分隔符 `,` / `.` 都认——
 * parseSubtitleBlocks 已经会把外部字幕规整成前者，但本地转写和第三方字幕文件
 * 两种都出现过，在这里兜住比在四个调用点各写一遍强。
 */
export const parseSrtTimestampToMs = (ts: string): number => {
  const m = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*$/u.exec(ts);
  if (m === null) return Number.NaN;
  const hours = m[1] !== undefined ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  // "500" 是 500ms，"5" 是 500ms —— 右侧补零到三位，不能直接 Number()
  const millis = Number(m[4]!.padEnd(3, "0"));
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
};

export const formatMsToSrtTimestamp = (ms: number): string => {
  const clamped = Math.max(0, Math.round(ms));
  const millis = clamped % 1000;
  const totalSeconds = (clamped - millis) / 1000;
  const seconds = totalSeconds % 60;
  const totalMinutes = (totalSeconds - seconds) / 60;
  const minutes = totalMinutes % 60;
  const hours = (totalMinutes - minutes) / 60;
  const pad = (n: number, width: number): string => String(n).padStart(width, "0");
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
};
