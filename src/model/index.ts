/**
 * 模型路由层
 *
 * 统一的模型发现、路由解析、per-peer 偏好管理。
 */
export { ModelResolver } from './model-resolver.ts';
export { PrefsStore } from './prefs-store.ts';
export { PREFS_SERVICE, PrefsReadout, providePrefs } from './prefs-readout.ts';
export { SettingsReader } from './settings-reader.ts';
export type { PrefsSnapshot } from './prefs-store.ts';
export type { PrefsEntry, PrefsOutlet } from './prefs-readout.ts';
export type { ModelRoute, ModelEntry } from './types.ts';
