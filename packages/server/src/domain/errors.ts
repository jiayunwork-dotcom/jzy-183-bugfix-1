import type { FieldError } from '@incli/shared';

/** 输入拒收：携带具体字段，HTTP 422。 */
export class ValidationError extends Error {
  readonly errors: FieldError[];
  constructor(errors: FieldError[]) {
    super(errors.map((e) => `${e.field}: ${e.message}`).join('; '));
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

/** 资源不存在，HTTP 404。 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * 乐观并发冲突：同一次测量（或同一条标定）已被另一笔更正提交，
 * 当前请求携带的 baseRevision 过期，HTTP 409。不静默覆盖。
 */
export class RevisionConflictError extends Error {
  readonly currentRevision: number;
  constructor(entity: string, currentRevision: number) {
    super(`${entity} 已被他人更正（当前版本 ${currentRevision}），本次提交未生效`);
    this.name = 'RevisionConflictError';
    this.currentRevision = currentRevision;
  }
}
