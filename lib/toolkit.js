/**
 * dsh-qqmail / lib/toolkit.js
 *
 * 为什么不用 `defineTool`：
 *   profile 的 node_modules 里没有 `@deepseek-ai/dsh-tools`（它是随 dsh 安装包
 *   一起装的 peer），插件从 profile 目录加载时 import 会解析失败。与其赌运行时
 *   的解析路径，不如自己把这 60 行补上：参数 DSL → 原始 JSON Schema、必填校验、
 *   枚举校验。其余（注册、调度、超时、渲染）仍然交给 ctx.tools。
 *
 * 支持的 DSL（与官方 defineTool 的风格一致，够用即可）：
 *   { type: 'string'|'integer'|'number'|'boolean'|'array'|'object'|'json',
 *     description?, required?: true, enum?, items?, properties?, additionalProperties? }
 */
import { JsonSchemaShapeError } from './errors.js';

const SCALARS = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/** 参数 DSL → 原始 JSON Schema（对象根）。 */
export function compileParameters(spec = {}) {
  const properties = {};
  const required = [];
  for (const [key, def] of Object.entries(spec)) {
    if (!def || typeof def !== 'object') throw new JsonSchemaShapeError(`参数 ${key} 的定义必须是对象`);
    const node = compileValue(def, key);
    properties[key] = node;
    if (def.required === true) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function compileValue(def, path) {
  const node = {};
  if (typeof def.description === 'string') node.description = def.description;
  if (def.default !== undefined) node.default = def.default;

  if (def.type === 'json' || def.type === undefined) {
    // 不受约束的 JSON：合法的注解式 schema
    return node;
  }

  // 收件人类参数：模型既可能传 "a@b.c"，也可能传 ["a@b.c","c@d.e"]，
  // 两种都该接受。schema 上放宽为任意 JSON，实际校验放在 validateValue。
  if (def.type === 'stringOrArray') {
    return node;
  }

  if (def.type === 'array') {
    node.type = 'array';
    if (def.items !== undefined) node.items = compileValue(def.items, `${path}[]`);
    return node;
  }

  if (def.type === 'object') {
    node.type = 'object';
    const props = {};
    const req = [];
    for (const [key, child] of Object.entries(def.properties ?? {})) {
      props[key] = compileValue(child, `${path}.${key}`);
      if (child?.required === true) req.push(key);
    }
    if (Object.keys(props).length > 0) node.properties = props;
    if (req.length > 0) node.required = req;
    node.additionalProperties = def.additionalProperties === true;
    return node;
  }

  if (!SCALARS.has(def.type)) {
    throw new JsonSchemaShapeError(`参数 ${path} 的 type 不支持：${def.type}`);
  }
  node.type = def.type;
  if (Array.isArray(def.enum)) {
    node.enum = def.enum.slice();
  }
  return node;
}

/** 用编译好的 schema 做参数校验，返回人类可读的错误列表。 */
export function validateArguments(schema, args) {
  const problems = [];
  if (schema.type === 'object') {
    const value = args ?? {};
    if (typeof value !== 'object' || Array.isArray(value)) {
      return ['arguments 必须是对象'];
    }
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) problems.push(`缺少必填参数 ${key}`);
    }
    for (const [key, def] of Object.entries(schema.properties ?? {})) {
      const provided = value[key];
      if (provided === undefined) continue;
      problems.push(...validateValue(def, provided, key));
    }
  }
  return problems;
}

function validateValue(schema, value, path) {
  const problems = [];
  if (!schema || schema.type === undefined) return problems; // json / stringOrArray / 任意
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') problems.push(`${path} 应为字符串`);
      else if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        problems.push(`${path} 必须是 ${schema.enum.join(' / ')} 之一`);
      }
      break;
    case 'integer':
      if (!Number.isInteger(value)) problems.push(`${path} 应为整数`);
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) problems.push(`${path} 应为数字`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') problems.push(`${path} 应为布尔值`);
      break;
    case 'array':
      if (!Array.isArray(value)) {
        problems.push(`${path} 应为数组`);
        break;
      }
      if (schema.items) {
        value.forEach((item, index) => {
          problems.push(...validateValue(schema.items, item, `${path}[${index}]`));
        });
      }
      break;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        problems.push(`${path} 应为对象`);
        break;
      }
      for (const key of schema.required ?? []) {
        if (value[key] === undefined) problems.push(`${path}.${key} 为必填`);
      }
      for (const [key, def] of Object.entries(schema.properties ?? {})) {
        if (value[key] === undefined) continue;
        problems.push(...validateValue(def, value[key], `${path}.${key}`));
      }
      break;
    }
    default:
      break;
  }
  return problems;
}

/** 输出 schema：一段给人看的文本 + 原始结构化数据。 */
export const TEXT_AND_DATA_OUTPUT = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    data: {},
  },
  required: ['text'],
  additionalProperties: false,
};

/**
 * 把工具声明装成 ctx.tools.register 认得的形状。
 * @param {object} decl
 */
export function defineTool(decl) {
  const parameters = compileParameters(decl.parameters ?? {});
  return {
    name: decl.name,
    description: decl.description,
    parameters,
    output: {
      schema: TEXT_AND_DATA_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    ...(decl.timeoutMs !== undefined ? { timeoutMs: decl.timeoutMs } : {}),
    async execute(args, exec) {
      const problems = validateArguments(parameters, args);
      if (problems.length > 0) {
        const error = new Error(`参数不合法：${problems.join('；')}`);
        error.code = 'INVALID_ARGS';
        throw error;
      }
      return decl.execute(args ?? {}, exec);
    },
    ...(decl.isConcurrencySafe ? { isConcurrencySafe: decl.isConcurrencySafe } : {}),
  };
}
