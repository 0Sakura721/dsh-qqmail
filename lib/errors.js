/**
 * dsh-qqmail / lib/errors.js
 *
 * 插件自己的错误类型。不继承 HarnessError —— 那是 @deepseek-ai/dsh-llm 的类，
 * 在 profile 里解析不到，硬依赖会让插件起不来。普通的 Error + code 足够，
 * 工具层本来也会把失败整形成文本交给模型。
 */
export class QqMailPluginError extends Error {
  constructor(message, { code = 'QQMAIL_ERROR', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
  }
}

/** 参数 schema 声明写错了（插件作者的锅，不是模型传错参数）。 */
export class JsonSchemaShapeError extends QqMailPluginError {
  constructor(message) {
    super(message, { code: 'SCHEMA_SHAPE' });
  }
}

/** 配置里给了不认识的值。 */
export class ConfigError extends QqMailPluginError {
  constructor(message) {
    super(message, { code: 'CONFIG' });
  }
}
