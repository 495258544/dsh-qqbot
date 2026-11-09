/**
 * NGA 平台模块 — 对外出口
 *
 * 模块边界（2026-11-10）：NGA 是平台扩展，不属于聊天人格。
 * 聊天核心（persona/）不 import 这里；唯一的接线点是 bootstrap。
 * 其他分支只同步聊天修订时，跳过本目录即可。
 */
export {
  NgaClient,
  NgaError,
  formatNgaTime,
  loadCredentials,
  defaultNgaDir,
  KNOWN_FORUMS,
} from './nga.ts';
export {
  genQrSession,
  pollQrSession,
  renderQrBuffer,
  renderQrPng,
  saveCredentials,
  clearCredentials,
  ngaStatus,
  parseScriptVarStore,
} from './nga-capture.ts';
export {
  registerNgaTools,
  rememberQrSession,
  currentQrSession,
  forgetQrSession,
  QR_TTL_SEC,
  type RegisterNgaToolsOptions,
} from './tools.ts';
