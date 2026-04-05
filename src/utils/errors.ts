// errors.ts
export class HttpError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export class AuthExpiredError extends HttpError {
  constructor(message = '登录已失效，请重新登录', status = 401) {
    super(message, status);
    this.name = 'AuthExpiredError';
  }
}

export class PermissionDeniedError extends HttpError {
  constructor(message = '权限不足，无法执行此操作', status = 403) {
    super(message, status);
    this.name = 'PermissionDeniedError';
  }
}

export class MoovBoxNotFoundError extends Error {
  constructor(message = '未找到 moov box，无法生成 init') {
    super(message);
    this.name = 'MoovBoxNotFoundError';
  }
}

export class TfdtBoxNotFoundError extends Error {
  constructor(message = '未找到 tfdt box，无法归一化时间戳') {
    super(message);
    this.name = 'TfdtBoxNotFoundError';
  }
}

/**
 * 直播未开播错误
 */
export class LiveNotLiveError extends Error {
  constructor(message = '当前主播未开播') {
    super(message);
    this.name = 'LiveNotLiveError';
  }
}
