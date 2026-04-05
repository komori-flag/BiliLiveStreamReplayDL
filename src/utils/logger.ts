// src/utils/logger.ts

/**
 * 日志工具模块
 * 提供统一的日志格式输出
 * 支持 info / warn / error / debug 四种级别
 */

import chalk from "chalk";

/**
 * 获取当前时间的字符串格式
 * @returns 形如 [2025-11-07 23:58:01]
 */
function getTimeTag(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `[${y}-${m}-${d} ${h}:${min}:${s}]`;
}

/**
 * info 日志
 */
export function logInfo(...args: any[]): void {
  console.log(chalk.blueBright(`${getTimeTag()} [INFO]`), ...args);
}

/**
 * warn 日志
 */
export function logWarn(...args: any[]): void {
  console.warn(chalk.yellow(`${getTimeTag()} [WARN]`), ...args);
}

/**
 * error 日志
 */
export function logError(...args: any[]): void {
  console.error(chalk.red(`${getTimeTag()} [ERROR]`), ...args);
}

/**
 * debug 日志（仅在 DEBUG 环境变量开启时输出）
 */
export function logDebug(...args: any[]): void {
  if (process.env.DEBUG === "true") {
    console.debug(chalk.gray(`${getTimeTag()} [DEBUG]`), ...args);
  }
}

/**
 * 通用封装（支持未来扩展）
 */
export const logger = {
  info: logInfo,
  warn: logWarn,
  error: logError,
  debug: logDebug,
};

export default logger;
